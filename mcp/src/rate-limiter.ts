/**
 * Simple token bucket rate limiter for MCP tools.
 *
 * Port of crates/conduit-mcp/src/rate_limit.rs
 *
 * Uses a basic token bucket algorithm instead of the governor crate.
 */

export interface ToolRateLimit {
  requestsPerMinute: number;
  burst: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
  config: ToolRateLimit;
}

const DEFAULT_LIMIT: ToolRateLimit = {
  requestsPerMinute: 60,
  burst: 10,
};

export function defaultRateLimits(): Map<string, ToolRateLimit> {
  const limits = new Map<string, ToolRateLimit>();

  // Terminal tools
  limits.set('terminal_execute', { requestsPerMinute: 60, burst: 10 });
  limits.set('terminal_read_pane', { requestsPerMinute: 120, burst: 20 });
  limits.set('terminal_send_keys', { requestsPerMinute: 120, burst: 20 });
  limits.set('local_shell_create', { requestsPerMinute: 30, burst: 5 });

  // Screenshot tools - lower rate (expensive operation)
  limits.set('rdp_screenshot', { requestsPerMinute: 30, burst: 5 });
  limits.set('vnc_screenshot', { requestsPerMinute: 30, burst: 5 });
  limits.set('website_screenshot', { requestsPerMinute: 30, burst: 5 });

  // RDP/VNC input tools
  limits.set('rdp_click', { requestsPerMinute: 60, burst: 10 });
  limits.set('rdp_type', { requestsPerMinute: 60, burst: 10 });
  limits.set('rdp_send_key', { requestsPerMinute: 60, burst: 10 });
  limits.set('rdp_mouse_move', { requestsPerMinute: 120, burst: 20 });
  limits.set('rdp_mouse_drag', { requestsPerMinute: 60, burst: 10 });
  limits.set('rdp_get_dimensions', { requestsPerMinute: 60, burst: 10 });
  limits.set('vnc_click', { requestsPerMinute: 60, burst: 10 });
  limits.set('vnc_type', { requestsPerMinute: 60, burst: 10 });
  limits.set('vnc_send_key', { requestsPerMinute: 60, burst: 10 });
  limits.set('vnc_mouse_move', { requestsPerMinute: 120, burst: 20 });
  limits.set('vnc_get_dimensions', { requestsPerMinute: 60, burst: 10 });

  // Web tools
  limits.set('website_read_content', { requestsPerMinute: 60, burst: 10 });
  limits.set('website_navigate', { requestsPerMinute: 30, burst: 5 });

  // Credential tools - strict rate limiting
  limits.set('credential_read', { requestsPerMinute: 10, burst: 2 });
  limits.set('credential_create', { requestsPerMinute: 30, burst: 5 });
  limits.set('credential_list', { requestsPerMinute: 60, burst: 10 });
  limits.set('credential_delete', { requestsPerMinute: 30, burst: 5 });

  // Connection tools
  limits.set('connection_list', { requestsPerMinute: 60, burst: 10 });
  limits.set('connection_open', { requestsPerMinute: 30, burst: 5 });
  limits.set('connection_close', { requestsPerMinute: 30, burst: 5 });

  return limits;
}

export class RateLimitManager {
  private buckets = new Map<string, BucketState>();
  private config: Map<string, ToolRateLimit>;

  constructor(config: Map<string, ToolRateLimit>) {
    this.config = config;
  }

  private getBucket(tool: string): BucketState {
    let bucket = this.buckets.get(tool);
    if (!bucket) {
      const cfg = this.config.get(tool) ?? DEFAULT_LIMIT;
      bucket = {
        tokens: cfg.burst,
        lastRefill: Date.now(),
        config: cfg,
      };
      this.buckets.set(tool, bucket);
    }
    return bucket;
  }

  /**
   * Check if a request is allowed. Returns true if allowed, false if rate-limited.
   */
  check(tool: string): boolean {
    const bucket = this.getBucket(tool);
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;

    // Refill tokens based on elapsed time
    const tokensToAdd = (elapsedMs / 60000) * bucket.config.requestsPerMinute;
    bucket.tokens = Math.min(bucket.config.burst, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }
}
