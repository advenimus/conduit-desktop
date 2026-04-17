using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace ConduitWebView2;

/// <summary>
/// Creates a WS_POPUP window owned by Electron's HWND and embeds a WebView2 control.
/// Uses a popup (not WS_CHILD) to avoid cross-process child window input routing issues.
/// The popup is positioned in screen coordinates using ClientToScreen on the parent HWND.
/// Windows automatically hides/shows the owned popup when the owner is minimized/restored.
///
/// Threading model:
///   - UI thread (STA main): creates Win32 window, WebView2, processes commands via WndProc
///   - Background thread: reads pipe messages, enqueues them, posts WM_APP to wake UI thread
/// </summary>
public sealed class WebView2Host : IDisposable
{
    #region Win32 P/Invoke

    private const int WS_POPUP = unchecked((int)0x80000000);
    private const int WS_CLIPCHILDREN = 0x02000000;
    private const int WS_CLIPSIBLINGS = 0x04000000;

    private const int WS_EX_TOOLWINDOW = 0x00000080;

    private const int SW_SHOW = 5;
    private const int SW_HIDE = 0;

    private const int WM_DESTROY = 0x0002;
    private const int WM_SETFOCUS = 0x0007;
    private const uint WM_APP = 0x8000;

    private static readonly IntPtr HWND_TOP = IntPtr.Zero;
    private const uint SWP_SHOWWINDOW = 0x0040;

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public int cbSize;
        public int style;
        public WndProcDelegate lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(
        int dwExStyle, string lpClassName, string lpWindowName, int dwStyle,
        int x, int y, int nWidth, int nHeight,
        IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveWindow(IntPtr hWnd, int x, int y, int nWidth, int nHeight, bool bRepaint);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int nExitCode);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter,
        int x, int y, int cx, int cy, uint uFlags);

    #endregion

    private const string WindowClassName = "ConduitWebView2Host";

    /// <summary>
    /// Static instance reference so WndProc (static callback) can dispatch WM_APP
    /// to the instance. Only one WebView2Host exists per helper process.
    /// </summary>
    private static WebView2Host? s_instance;

    private readonly IntPtr _parentHwnd;
    private readonly PipeProtocol _pipe;
    private readonly CancellationTokenSource _cts;
    private readonly string _initialUrl;
    private readonly ConcurrentQueue<PipeMessage> _incomingMessages = new();

    private IntPtr _childHwnd;
    private CoreWebView2Controller? _controller;
    private CoreWebView2? _webView;
    private WndProcDelegate? _wndProc; // prevent GC of delegate
    private bool _disposed;

    /// <summary>
    /// Pending download deferrals keyed by downloadId.
    /// Holds the deferral and event args until the user responds via pipe.
    /// </summary>
    private readonly ConcurrentDictionary<string, (CoreWebView2Deferral Deferral, CoreWebView2DownloadStartingEventArgs Args)>
        _pendingDownloads = new();

    // Last screen-absolute bounds (sent by Electron using getContentBounds())
    private int _screenX, _screenY, _boundsW, _boundsH;

    public WebView2Host(IntPtr parentHwnd, PipeProtocol pipe, string initialUrl, CancellationTokenSource cts)
    {
        _parentHwnd = parentHwnd;
        _pipe = pipe;
        _initialUrl = initialUrl;
        _cts = cts;
        s_instance = this;
    }

    /// <summary>
    /// Creates the child window and initializes WebView2. Must be called on the UI thread.
    /// </summary>
    public async Task InitializeAsync()
    {
        CreateChildWindow();
        await InitializeWebView2Async();
    }

    private void CreateChildWindow()
    {
        var hInstance = GetModuleHandle(null);

        // Hold a reference to prevent garbage collection of the delegate
        _wndProc = WndProc;

        var wc = new WNDCLASSEX
        {
            cbSize = Marshal.SizeOf<WNDCLASSEX>(),
            lpfnWndProc = _wndProc,
            hInstance = hInstance,
            lpszClassName = WindowClassName,
        };

        RegisterClassEx(ref wc);

        // Use WS_POPUP (not WS_CHILD) to avoid cross-process child window input issues.
        // Setting hWndParent on a WS_POPUP establishes an OWNER relationship:
        //   - Popup stays above the owner in z-order
        //   - Windows auto-hides popup when owner is minimized
        //   - Windows auto-shows popup when owner is restored
        // WS_EX_TOOLWINDOW prevents the popup from appearing in taskbar or Alt+Tab.
        // Start at 0,0 size 1,1 hidden — will be shown and positioned when set_bounds arrives.
        _childHwnd = CreateWindowEx(
            WS_EX_TOOLWINDOW,
            WindowClassName,
            "ConduitWebView2",
            WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0, 0, 1, 1,
            _parentHwnd,
            IntPtr.Zero,
            hInstance,
            IntPtr.Zero);

        if (_childHwnd == IntPtr.Zero)
        {
            var errorCode = Marshal.GetLastWin32Error();
            throw new InvalidOperationException(
                $"CreateWindowEx failed with error code {errorCode}");
        }
    }

    private async Task InitializeWebView2Async()
    {
        try
        {
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Conduit", "WebView2Data");

            var options = new CoreWebView2EnvironmentOptions
            {
                AllowSingleSignOnUsingOSPrimaryAccount = true,
                AdditionalBrowserArguments = "--enable-features=msSingleSignOnOSForPrimaryAccountIsShared"
            };

            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userDataFolder,
                options: options);

            _controller = await environment.CreateCoreWebView2ControllerAsync(_childHwnd);
            _webView = _controller.CoreWebView2;

            // Ensure the controller is visible and fills the child window
            _controller.IsVisible = true;
            _controller.Bounds = new System.Drawing.Rectangle(0, 0, 1, 1);

            // Wire up events
            _webView.NavigationCompleted += OnNavigationCompleted;
            _webView.DocumentTitleChanged += OnDocumentTitleChanged;
            _webView.NewWindowRequested += OnNewWindowRequested;
            _webView.DownloadStarting += OnDownloadStarting;

            // Navigate to initial URL if provided
            if (!string.IsNullOrEmpty(_initialUrl))
            {
                _webView.Navigate(_initialUrl);
            }

            // Notify that WebView2 is ready
            await _pipe.WriteMessageAsync(new PipeMessage { Type = "ready" }, _cts.Token);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            await _pipe.SendErrorAsync(
                "WebView2 Runtime is not installed. Download it from https://developer.microsoft.com/en-us/microsoft-edge/webview2/",
                _cts.Token);
            RequestShutdown();
        }
        catch (Exception ex)
        {
            await _pipe.SendErrorAsync($"WebView2 initialization failed: {ex.Message}", _cts.Token);
            RequestShutdown();
        }
    }

    /// <summary>
    /// Reads messages from the pipe on a background thread.
    /// Enqueues them and posts WM_APP to the child window so the UI thread processes them.
    /// </summary>
    public async Task RunMessageLoopAsync()
    {
        while (!_cts.Token.IsCancellationRequested)
        {
            var message = await _pipe.ReadMessageAsync(_cts.Token);

            if (message is null)
            {
                // Pipe disconnected
                RequestShutdown();
                break;
            }

            // Enqueue for UI thread processing
            _incomingMessages.Enqueue(message);
            PostMessage(_childHwnd, WM_APP, IntPtr.Zero, IntPtr.Zero);
        }
    }

    /// <summary>
    /// Called on the UI thread (from WndProc) to process queued pipe messages.
    /// </summary>
    private void ProcessQueuedMessages()
    {
        while (_incomingMessages.TryDequeue(out var message))
        {
            _ = HandleMessageAsync(message);
        }
    }

    private async Task HandleMessageAsync(PipeMessage message)
    {
        try
        {
            switch (message.Type)
            {
                case "navigate":
                    HandleNavigate(message);
                    break;

                case "bounds":
                case "set_bounds":
                    HandleBounds(message);
                    break;

                case "show":
                    UpdateScreenPosition();
                    _controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                    break;

                case "hide":
                    ShowWindow(_childHwnd, SW_HIDE);
                    break;

                case "close":
                    RequestShutdown();
                    break;

                case "go_back":
                    _webView?.GoBack();
                    break;

                case "go_forward":
                    _webView?.GoForward();
                    break;

                case "execute_script":
                    await HandleExecuteScriptAsync(message);
                    break;

                case "capture_screenshot":
                    await HandleCaptureScreenshotAsync(message);
                    break;

                case "download_response":
                    HandleDownloadResponse(message);
                    break;

                default:
                    await _pipe.SendErrorAsync($"Unknown message type: {message.Type}", _cts.Token);
                    break;
            }
        }
        catch (Exception ex)
        {
            await _pipe.SendErrorAsync($"Error handling '{message.Type}': {ex.Message}", _cts.Token);
        }
    }

    private void HandleNavigate(PipeMessage message)
    {
        if (_webView is null)
        {
            _ = _pipe.SendErrorAsync("WebView2 not initialized", _cts.Token);
            return;
        }

        if (string.IsNullOrEmpty(message.Url))
        {
            _ = _pipe.SendErrorAsync("navigate: 'url' field is required", _cts.Token);
            return;
        }

        _webView.Navigate(message.Url);
    }

    private void HandleBounds(PipeMessage message)
    {
        if (_childHwnd == IntPtr.Zero) return;

        // Electron sends absolute screen coordinates (computed via getContentBounds())
        _screenX = message.X ?? 0;
        _screenY = message.Y ?? 0;
        _boundsW = message.Width ?? 800;
        _boundsH = message.Height ?? 600;

        UpdateScreenPosition();
    }

    /// <summary>
    /// Positions the popup window at the stored screen coordinates.
    /// Called on initial bounds and when the parent window moves/resizes
    /// (Electron recomputes and resends screen coordinates).
    /// </summary>
    private void UpdateScreenPosition()
    {
        if (_childHwnd == IntPtr.Zero) return;

        Console.Error.WriteLine(
            $"[WV2-Helper] set_bounds: screen=({_screenX},{_screenY}), size=({_boundsW},{_boundsH})");

        // Position the popup at screen coordinates and bring to top of z-order
        SetWindowPos(_childHwnd, HWND_TOP, _screenX, _screenY, _boundsW, _boundsH, SWP_SHOWWINDOW);

        // Resize the WebView2 controller to fill the popup window
        if (_controller is not null)
        {
            _controller.Bounds = new System.Drawing.Rectangle(0, 0, _boundsW, _boundsH);
        }
    }

    private async Task HandleExecuteScriptAsync(PipeMessage message)
    {
        if (_webView is null)
        {
            await _pipe.SendErrorAsync("WebView2 not initialized", _cts.Token);
            return;
        }

        var script = message.Code ?? message.Script;
        if (string.IsNullOrEmpty(script))
        {
            await _pipe.SendErrorAsync("execute_script: 'code' or 'script' field is required", _cts.Token);
            return;
        }

        var result = await _webView.ExecuteScriptAsync(script);

        await _pipe.WriteMessageAsync(new PipeMessage
        {
            Type = "script_result",
            Id = message.Id,
            Result = result,
        }, _cts.Token);
    }

    private async Task HandleCaptureScreenshotAsync(PipeMessage message)
    {
        if (_webView is null)
        {
            await _pipe.SendErrorAsync("WebView2 not initialized", _cts.Token);
            return;
        }

        var resultJson = await _webView.CallDevToolsProtocolMethodAsync(
            "Page.captureScreenshot",
            "{\"format\":\"png\"}");

        // Parse the CDP response to extract the base64 data
        using var doc = JsonDocument.Parse(resultJson);
        var base64Data = doc.RootElement.GetProperty("data").GetString();

        await _pipe.WriteMessageAsync(new PipeMessage
        {
            Type = "screenshot",
            Id = message.Id,
            Data = base64Data,
        }, _cts.Token);
    }

    #region WebView2 Events

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        _ = _pipe.WriteMessageAsync(new PipeMessage
        {
            Type = "navigation_completed",
            Url = _webView?.Source,
            Success = e.IsSuccess,
            CanGoBack = _webView?.CanGoBack,
            CanGoForward = _webView?.CanGoForward,
        }, _cts.Token);
    }

    private void OnDocumentTitleChanged(object? sender, object e)
    {
        _ = _pipe.WriteMessageAsync(new PipeMessage
        {
            Type = "title_changed",
            Title = _webView?.DocumentTitle,
        }, _cts.Token);
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        // Prevent the default behavior (opening in WebView2)
        e.Handled = true;

        // Notify Electron so it can handle the URL
        _ = _pipe.WriteMessageAsync(new PipeMessage
        {
            Type = "new_window_requested",
            Url = e.Uri,
        }, _cts.Token);
    }

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        var downloadId = Guid.NewGuid().ToString();

        // Suppress the default download dialog
        e.Handled = true;

        // Hold the download decision with a deferral
        var deferral = e.GetDeferral();
        _pendingDownloads[downloadId] = (deferral, e);

        // Extract filename from the suggested result path
        var suggestedFilename = Path.GetFileName(e.ResultFilePath) ?? "download";

        var operation = e.DownloadOperation;
        var totalBytes = operation.TotalBytesToReceive ?? 0;

        // Send download info to Electron
        _ = _pipe.WriteMessageAsync(new PipeMessage
        {
            Type = "download_starting",
            Id = downloadId,
            Url = operation.Uri,
            Title = suggestedFilename,
            Data = totalBytes.ToString(),
            Result = operation.MimeType,
        }, _cts.Token);

        // Wire up progress tracking
        operation.BytesReceivedChanged += (s, args) =>
        {
            _ = _pipe.WriteMessageAsync(new PipeMessage
            {
                Type = "download_progress",
                Id = downloadId,
                Data = operation.BytesReceived.ToString(),
                Result = (operation.TotalBytesToReceive ?? 0).ToString(),
            }, _cts.Token);
        };

        // Wire up state change (completed/interrupted)
        operation.StateChanged += (s, args) =>
        {
            var state = operation.State switch
            {
                CoreWebView2DownloadState.Completed => "completed",
                CoreWebView2DownloadState.Interrupted => "interrupted",
                _ => "in_progress",
            };

            if (state != "in_progress")
            {
                _ = _pipe.WriteMessageAsync(new PipeMessage
                {
                    Type = "download_done",
                    Id = downloadId,
                    Data = state,
                    Url = e.ResultFilePath,
                }, _cts.Token);
                _pendingDownloads.TryRemove(downloadId, out _);
            }
        };
    }

    private void HandleDownloadResponse(PipeMessage message)
    {
        if (message.Id == null || !_pendingDownloads.TryRemove(message.Id, out var pending))
        {
            return;
        }

        var (deferral, args) = pending;
        var action = message.Data; // "open", "save", "cancel"

        if (action == "cancel")
        {
            args.Cancel = true;
        }
        else if (action == "open" || action == "save")
        {
            // Set the file path from the pipe message
            if (!string.IsNullOrEmpty(message.Url))
            {
                args.ResultFilePath = message.Url;
            }
        }

        deferral.Complete();
    }

    #endregion

    private void RequestShutdown()
    {
        if (!_cts.IsCancellationRequested)
        {
            _cts.Cancel();
        }
        PostQuitMessage(0);
    }

    private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_APP && s_instance != null)
        {
            s_instance.ProcessQueuedMessages();
            return IntPtr.Zero;
        }

        if (msg == WM_SETFOCUS && s_instance?._controller != null)
        {
            // Transfer focus to WebView2 so it receives keyboard/mouse input
            s_instance._controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
            return IntPtr.Zero;
        }

        if (msg == WM_DESTROY)
        {
            PostQuitMessage(0);
            return IntPtr.Zero;
        }

        return DefWindowProc(hWnd, msg, wParam, lParam);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        if (_webView is not null)
        {
            _webView.NavigationCompleted -= OnNavigationCompleted;
            _webView.DocumentTitleChanged -= OnDocumentTitleChanged;
            _webView.NewWindowRequested -= OnNewWindowRequested;
            _webView.DownloadStarting -= OnDownloadStarting;
        }

        // Cancel any pending download deferrals
        foreach (var (id, (deferral, args)) in _pendingDownloads)
        {
            args.Cancel = true;
            deferral.Complete();
        }
        _pendingDownloads.Clear();

        _controller?.Close();
        _controller = null;
        _webView = null;

        if (_childHwnd != IntPtr.Zero)
        {
            DestroyWindow(_childHwnd);
            _childHwnd = IntPtr.Zero;
        }

        s_instance = null;
    }
}
