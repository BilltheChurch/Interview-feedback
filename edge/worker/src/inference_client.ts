export type InferenceBackendKey = "primary" | "secondary";

export type InferenceEndpointKey =
  | "resolve"
  | "enroll"
  | "analysis_events"
  | "analysis_report"
  | "analysis_regenerate_claim"
  | "analysis_synthesize";

type EndpointHealthState = "unknown" | "healthy" | "degraded" | "open_circuit";

interface EndpointRuntimeState {
  status: EndpointHealthState;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  circuit_open_until_ms: number;
  circuit_open_until: string | null;
}

interface BackendRuntimeState {
  role: InferenceBackendKey;
  base_url: string;
  endpoints: Record<InferenceEndpointKey, EndpointRuntimeState>;
}

export interface DependencyHealthSnapshot {
  mode: "single" | "failover";
  active_backend: InferenceBackendKey;
  failover_enabled: boolean;
  updated_at: string;
  last_switch_at: string | null;
  last_error: string | null;
  primary: BackendRuntimeState;
  secondary: BackendRuntimeState | null;
}

export interface InferenceBackendTimelineItem {
  ts: string;
  endpoint: InferenceEndpointKey;
  backend: InferenceBackendKey;
  outcome: "ok" | "failed" | "skipped";
  detail: string;
  attempt: number;
}

export interface InferenceCallSuccess<T> {
  data: T;
  backend: InferenceBackendKey;
  degraded: boolean;
  warnings: string[];
  timeline: InferenceBackendTimelineItem[];
  health: DependencyHealthSnapshot;
}

interface InferenceCallFailureDetail {
  backend: InferenceBackendKey;
  attempt: number;
  status: number | null;
  retryable: boolean;
  detail: string;
}

export class InferenceRequestError extends Error {
  readonly endpoint: InferenceEndpointKey;
  readonly failures: InferenceCallFailureDetail[];
  readonly timeline: InferenceBackendTimelineItem[];
  readonly health: DependencyHealthSnapshot;
  readonly code: "all_backends_failed";

  constructor(params: {
    endpoint: InferenceEndpointKey;
    failures: InferenceCallFailureDetail[];
    timeline: InferenceBackendTimelineItem[];
    health: DependencyHealthSnapshot;
  }) {
    const compact = params.failures
      .map((item) => `${item.backend}#${item.attempt} status=${item.status ?? "network"} ${item.detail}`)
      .join(" | ");
    super(`${params.endpoint} failed: ${compact}`);
    this.name = "InferenceRequestError";
    this.endpoint = params.endpoint;
    this.failures = params.failures;
    this.timeline = params.timeline;
    this.health = params.health;
    this.code = "all_backends_failed";
  }
}

interface InferenceClientConfig {
  primaryBaseUrl: string;
  secondaryBaseUrl?: string | null;
  failoverEnabled: boolean;
  apiKey?: string;
  timeoutMs: number;
  retryMax: number;
  retryBackoffMs: number;
  circuitOpenMs: number;
  now: () => string;
}

interface InferenceCallRequest {
  endpoint: InferenceEndpointKey;
  path: string;
  body: unknown;
  timeoutMs?: number;
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function defaultEndpointState(): EndpointRuntimeState {
  return {
    status: "unknown",
    consecutive_failures: 0,
    last_success_at: null,
    last_failure_at: null,
    last_error: null,
    circuit_open_until_ms: 0,
    circuit_open_until: null
  };
}

function buildBackendState(role: InferenceBackendKey, baseUrl: string): BackendRuntimeState {
  return {
    role,
    base_url: baseUrl,
    endpoints: {
      resolve: defaultEndpointState(),
      enroll: defaultEndpointState(),
      analysis_events: defaultEndpointState(),
      analysis_report: defaultEndpointState(),
      analysis_regenerate_claim: defaultEndpointState(),
      analysis_synthesize: defaultEndpointState()
    }
  };
}

function classifyHttpFailure(status: number, bodyText: string): { detail: string; retryable: boolean } {
  const detail = `status=${status} body=${bodyText.slice(0, 280)}`;
  if (status >= 500) return { detail, retryable: true };
  if (status === 429 || status === 408) return { detail, retryable: true };
  return { detail, retryable: false };
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InferenceFailoverClient {
  private readonly config: InferenceClientConfig;
  private readonly primary: BackendRuntimeState;
  private readonly secondary: BackendRuntimeState | null;
  private activeBackend: InferenceBackendKey = "primary";
  private lastSwitchAt: string | null = null;
  private lastError: string | null = null;

  constructor(config: InferenceClientConfig) {
    this.config = config;
    this.primary = buildBackendState("primary", normalizeBaseUrl(config.primaryBaseUrl));
    this.secondary =
      config.secondaryBaseUrl && normalizeBaseUrl(config.secondaryBaseUrl).length > 0
        ? buildBackendState("secondary", normalizeBaseUrl(config.secondaryBaseUrl))
        : null;
  }

  snapshot(): DependencyHealthSnapshot {
    return {
      mode: this.config.failoverEnabled && this.secondary ? "failover" : "single",
      active_backend: this.activeBackend,
      failover_enabled: this.config.failoverEnabled && Boolean(this.secondary),
      updated_at: this.config.now(),
      last_switch_at: this.lastSwitchAt,
      last_error: this.lastError,
      primary: this.primary,
      secondary: this.secondary
    };
  }

  private markSuccess(backend: BackendRuntimeState, endpoint: InferenceEndpointKey): void {
    const nowIso = this.config.now();
    const node = backend.endpoints[endpoint];
    node.status = "healthy";
    node.consecutive_failures = 0;
    node.last_success_at = nowIso;
    node.last_error = null;
    node.circuit_open_until_ms = 0;
    node.circuit_open_until = null;
  }

  private markFailure(
    backend: BackendRuntimeState,
    endpoint: InferenceEndpointKey,
    message: string,
    allowCircuitOpen: boolean
  ): void {
    const nowIso = this.config.now();
    const nowMs = Date.now();
    const node = backend.endpoints[endpoint];
    node.consecutive_failures += 1;
    node.last_failure_at = nowIso;
    node.last_error = message;
    node.status = "degraded";

    if (allowCircuitOpen && node.consecutive_failures >= 2) {
      const openUntilMs = nowMs + this.config.circuitOpenMs;
      node.status = "open_circuit";
      node.circuit_open_until_ms = openUntilMs;
      node.circuit_open_until = new Date(openUntilMs).toISOString();
    }
    this.lastError = `${backend.role}:${endpoint}:${message}`;
  }

  private backendByRole(role: InferenceBackendKey): BackendRuntimeState {
    if (role === "primary") return this.primary;
    if (!this.secondary) {
      throw new Error("secondary backend is not configured");
    }
    return this.secondary;
  }

  private candidateBackends(): InferenceBackendKey[] {
    if (!this.config.failoverEnabled || !this.secondary) {
      return ["primary"];
    }
    return ["primary", "secondary"];
  }

  private shouldSkipByCircuit(backend: BackendRuntimeState, endpoint: InferenceEndpointKey): boolean {
    const node = backend.endpoints[endpoint];
    if (node.status !== "open_circuit") return false;
    if (!node.circuit_open_until_ms) return false;
    if (Date.now() >= node.circuit_open_until_ms) {
      node.status = "degraded";
      node.circuit_open_until_ms = 0;
      node.circuit_open_until = null;
      return false;
    }
    return true;
  }

  private async fetchJson(
    backend: BackendRuntimeState,
    request: InferenceCallRequest,
    attempt: number
  ): Promise<{ data: unknown } | { detail: string; retryable: boolean; status: number | null }> {
    const timeoutMs = Number.isFinite(request.timeoutMs) && request.timeoutMs && request.timeoutMs > 0
      ? request.timeoutMs
      : this.config.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(backend.base_url + request.path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {})
        },
        body: JSON.stringify(request.body),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        const failed = classifyHttpFailure(response.status, text);
        return { detail: failed.detail, retryable: failed.retryable, status: response.status };
      }
      try {
        return { data: text ? (JSON.parse(text) as unknown) : {} };
      } catch {
        return {
          detail: `status=${response.status} body=non-json response`,
          retryable: true,
          status: response.status
        };
      }
    } catch (error) {
      const detail = normalizeErrorMessage(error);
      const aborted = detail.toLowerCase().includes("aborted") || detail.toLowerCase().includes("timeout");
      return { detail: `network error: ${detail}`, retryable: aborted || attempt <= this.config.retryMax, status: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async callJson<T>(request: InferenceCallRequest): Promise<InferenceCallSuccess<T>> {
    const timeline: InferenceBackendTimelineItem[] = [];
    const failures: InferenceCallFailureDetail[] = [];
    const warnings: string[] = [];
    const candidates = this.candidateBackends();
    const maxAttempts = Math.max(1, this.config.retryMax + 1);

    for (const backendRole of candidates) {
      const backend = this.backendByRole(backendRole);
      if (this.shouldSkipByCircuit(backend, request.endpoint)) {
        timeline.push({
          ts: this.config.now(),
          endpoint: request.endpoint,
          backend: backend.role,
          outcome: "skipped",
          detail: "circuit open",
          attempt: 0
        });
        warnings.push(`${backend.role} circuit open for ${request.endpoint}`);
        continue;
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const result = await this.fetchJson(backend, request, attempt);
        if ("data" in result) {
          this.markSuccess(backend, request.endpoint);
          timeline.push({
            ts: this.config.now(),
            endpoint: request.endpoint,
            backend: backend.role,
            outcome: "ok",
            detail: "success",
            attempt
          });
          if (this.activeBackend !== backend.role) {
            this.lastSwitchAt = this.config.now();
          }
          this.activeBackend = backend.role;
          const degraded = backend.role !== "primary";
          if (degraded) {
            warnings.push(`using secondary backend for ${request.endpoint}`);
          }
          return {
            data: result.data as T,
            backend: backend.role,
            degraded,
            warnings,
            timeline,
            health: this.snapshot()
          };
        }

        failures.push({
          backend: backend.role,
          attempt,
          status: result.status,
          retryable: result.retryable,
          detail: result.detail
        });
        this.markFailure(backend, request.endpoint, result.detail, true);
        timeline.push({
          ts: this.config.now(),
          endpoint: request.endpoint,
          backend: backend.role,
          outcome: "failed",
          detail: result.detail,
          attempt
        });

        if (!result.retryable || attempt >= maxAttempts) {
          break;
        }
        const backoff = Math.max(80, this.config.retryBackoffMs * attempt);
        await delay(backoff);
      }
    }

    throw new InferenceRequestError({
      endpoint: request.endpoint,
      failures,
      timeline,
      health: this.snapshot()
    });
  }
}
