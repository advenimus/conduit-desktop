using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ConduitWebView2;

/// <summary>
/// Newline-delimited JSON message envelope for pipe communication.
/// Each message has a "type" field and optional additional fields.
/// </summary>
public sealed class PipeMessage
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("url")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Url { get; set; }

    [JsonPropertyName("title")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Title { get; set; }

    [JsonPropertyName("success")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Success { get; set; }

    [JsonPropertyName("x")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? X { get; set; }

    [JsonPropertyName("y")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Y { get; set; }

    [JsonPropertyName("width")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Width { get; set; }

    [JsonPropertyName("height")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Height { get; set; }

    [JsonPropertyName("script")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Script { get; set; }

    [JsonPropertyName("code")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Code { get; set; }

    [JsonPropertyName("result")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Result { get; set; }

    [JsonPropertyName("data")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Data { get; set; }

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; set; }

    [JsonPropertyName("id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Id { get; set; }

    [JsonPropertyName("can_go_back")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? CanGoBack { get; set; }

    [JsonPropertyName("can_go_forward")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? CanGoForward { get; set; }
}

/// <summary>
/// Handles reading and writing newline-delimited JSON messages over a named pipe.
/// </summary>
public sealed class PipeProtocol : IDisposable
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly NamedPipeServerStream _pipe;
    private readonly StreamReader _reader;
    private readonly StreamWriter _writer;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private bool _disposed;

    public PipeProtocol(string pipeName)
    {
        // NamedPipeServerStream expects just the pipe name, not the full path.
        // Strip \\.\pipe\ prefix if passed.
        if (pipeName.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase))
        {
            pipeName = pipeName[@"\\.\pipe\".Length..];
        }

        _pipe = new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);

        var utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        _reader = new StreamReader(_pipe, utf8NoBom);
        _writer = new StreamWriter(_pipe, utf8NoBom);
    }

    /// <summary>
    /// Waits for a client to connect to the pipe.
    /// </summary>
    public async Task WaitForConnectionAsync(CancellationToken ct = default)
    {
        await _pipe.WaitForConnectionAsync(ct);
    }

    /// <summary>
    /// Reads the next newline-delimited JSON message from the pipe.
    /// Returns null if the pipe is disconnected or EOF is reached.
    /// </summary>
    public async Task<PipeMessage?> ReadMessageAsync(CancellationToken ct = default)
    {
        try
        {
            var line = await _reader.ReadLineAsync(ct);
            if (line is null)
            {
                return null;
            }

            var trimmed = line.Trim();
            if (trimmed.Length == 0)
            {
                // Empty line — skip, don't treat as EOF
                return await ReadMessageAsync(ct);
            }

            return JsonSerializer.Deserialize<PipeMessage>(trimmed, SerializerOptions);
        }
        catch (IOException)
        {
            return null;
        }
        catch (OperationCanceledException)
        {
            return null;
        }
    }

    /// <summary>
    /// Writes a newline-delimited JSON message to the pipe.
    /// Thread-safe via semaphore.
    /// </summary>
    public async Task WriteMessageAsync(PipeMessage message, CancellationToken ct = default)
    {
        if (_disposed || !_pipe.IsConnected) return;

        await _writeLock.WaitAsync(ct);
        try
        {
            var json = JsonSerializer.Serialize(message, SerializerOptions);
            await _writer.WriteLineAsync(json.AsMemory(), ct);
            await _writer.FlushAsync(ct);
        }
        catch (IOException)
        {
            // Pipe disconnected — ignore
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>
    /// Convenience method to send an error message.
    /// </summary>
    public Task SendErrorAsync(string error, CancellationToken ct = default)
    {
        return WriteMessageAsync(new PipeMessage { Type = "error", Error = error }, ct);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _writeLock.Dispose();
        _reader.Dispose();
        _writer.Dispose();
        _pipe.Dispose();
    }
}
