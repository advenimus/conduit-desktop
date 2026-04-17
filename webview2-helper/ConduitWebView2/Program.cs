using System.Runtime.InteropServices;

namespace ConduitWebView2;

/// <summary>
/// Entry point for the Conduit WebView2 helper process.
///
/// Usage: ConduitWebView2.exe --hwnd=<HWND> --pipe=<name> --url=<url>
///
///   --hwnd   Parent window handle (decimal) from Electron
///   --pipe   Named pipe name for JSON communication
///   --url    Initial URL to navigate to (optional)
/// </summary>
internal static class Program
{
    #region Win32 Message Loop

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    #endregion

    [STAThread]
    static void Main(string[] args)
    {
        IntPtr parentHwnd = IntPtr.Zero;
        string? pipeName = null;
        string? initialUrl = null;

        Console.Error.WriteLine("[WV2-Helper] Starting up...");
        Console.Error.WriteLine($"[WV2-Helper] Args: {string.Join(" ", args)}");

        foreach (var arg in args)
        {
            if (arg.StartsWith("--hwnd=", StringComparison.OrdinalIgnoreCase))
            {
                var value = arg["--hwnd=".Length..];
                if (long.TryParse(value, out var hwndValue))
                {
                    parentHwnd = new IntPtr(hwndValue);
                }
            }
            else if (arg.StartsWith("--pipe=", StringComparison.OrdinalIgnoreCase))
            {
                pipeName = arg["--pipe=".Length..];
            }
            else if (arg.StartsWith("--url=", StringComparison.OrdinalIgnoreCase))
            {
                initialUrl = arg["--url=".Length..];
            }
        }

        Console.Error.WriteLine($"[WV2-Helper] Parsed: hwnd={parentHwnd}, pipe={pipeName}, url={initialUrl}");

        if (parentHwnd == IntPtr.Zero)
        {
            Console.Error.WriteLine("Error: --hwnd=<HWND> is required");
            Environment.Exit(1);
            return;
        }

        if (string.IsNullOrEmpty(pipeName))
        {
            Console.Error.WriteLine("Error: --pipe=<name> is required");
            Environment.Exit(1);
            return;
        }

        using var cts = new CancellationTokenSource();
        PipeProtocol? pipe = null;
        WebView2Host? host = null;

        try
        {
            Console.Error.WriteLine("[WV2-Helper] Creating pipe server...");
            pipe = new PipeProtocol(pipeName);

            // Wait for Electron to connect to the pipe (with timeout)
            Console.Error.WriteLine("[WV2-Helper] Waiting for client connection...");
            var connectTask = pipe.WaitForConnectionAsync(cts.Token);
            if (!connectTask.Wait(TimeSpan.FromSeconds(10)))
            {
                Console.Error.WriteLine("Error: Pipe connection timed out");
                Environment.Exit(1);
                return;
            }
            Console.Error.WriteLine("[WV2-Helper] Client connected to pipe.");

            Console.Error.WriteLine("[WV2-Helper] Creating WebView2Host...");
            host = new WebView2Host(parentHwnd, pipe, initialUrl ?? string.Empty, cts);

            // Initialize WebView2 on the STA thread
            Console.Error.WriteLine("[WV2-Helper] Initializing WebView2...");
            var initTask = host.InitializeAsync();
            // Pump messages while waiting for async init to complete
            PumpMessagesUntilComplete(initTask);

            if (initTask.IsFaulted)
            {
                var ex = initTask.Exception?.InnerException ?? initTask.Exception;
                Console.Error.WriteLine($"Error: WebView2 initialization failed: {ex?.Message}");
                Environment.Exit(1);
                return;
            }

            Console.Error.WriteLine("[WV2-Helper] WebView2 initialized. Starting message loop...");

            // Start the pipe message reader on a background thread
            _ = Task.Run(() => host.RunMessageLoopAsync(), cts.Token);

            // Run the Win32 message loop on the main (STA) thread
            RunMessageLoop();
        }
        catch (OperationCanceledException)
        {
            Console.Error.WriteLine("[WV2-Helper] Shutdown (cancelled).");
        }
        catch (AggregateException aex)
        {
            var inner = aex.InnerException ?? aex;
            Console.Error.WriteLine($"Fatal error: {inner.GetType().Name}: {inner.Message}");
            Console.Error.WriteLine(inner.StackTrace);
            Environment.Exit(1);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Fatal error: {ex.GetType().Name}: {ex.Message}");
            Console.Error.WriteLine(ex.StackTrace);
            Environment.Exit(1);
        }
        finally
        {
            host?.Dispose();
            pipe?.Dispose();
        }
    }

    /// <summary>
    /// Standard Win32 message loop. Runs until WM_QUIT is posted.
    /// </summary>
    private static void RunMessageLoop()
    {
        while (GetMessage(out var msg, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }

    /// <summary>
    /// Pumps Win32 messages while waiting for an async task to complete.
    /// This is needed because WebView2 initialization requires the message loop to run
    /// while we await async operations on the STA thread.
    /// </summary>
    private static void PumpMessagesUntilComplete(Task task)
    {
        while (!task.IsCompleted)
        {
            // Process any pending Win32 messages
            if (PeekMessage(out var msg, IntPtr.Zero, 0, 0, PM_REMOVE))
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            else
            {
                // No messages — yield briefly to avoid busy spin
                Thread.Sleep(1);
            }
        }

        // Propagate exceptions
        task.GetAwaiter().GetResult();
    }

    private const uint PM_REMOVE = 0x0001;

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);
}
