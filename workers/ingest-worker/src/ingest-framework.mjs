const DEFAULT_PARSER = 'unknown';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeHeaderMap(headers) {
  const result = {};
  const source = headers || {};
  for (const [key, value] of Object.entries(source)) {
    if (!key) continue;
    result[String(key).toLowerCase()] = String(value);
  }
  return result;
}

function isJsonContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase();
  return normalized.includes('application/json');
}

function isNdjsonContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase();
  return normalized.includes('application/x-ndjson') || normalized.includes('application/ndjson');
}

function anyValueToJs(value, depth = 0) {
  if (!value || depth > 5) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'boolValue')) return Boolean(value.boolValue);
  if (Object.prototype.hasOwnProperty.call(value, 'intValue')) return Number(value.intValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'bytesValue')) return value.bytesValue;
  if (value.arrayValue && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values.map((item) => anyValueToJs(item, depth + 1));
  }
  if (value.kvlistValue && Array.isArray(value.kvlistValue.values)) {
    const out = {};
    for (const entry of value.kvlistValue.values) {
      const key = asString(entry?.key);
      if (!key) continue;
      out[key] = anyValueToJs(entry?.value, depth + 1);
    }
    return out;
  }
  return null;
}

function attributesToObject(attributes) {
  const out = {};
  for (const entry of asArray(attributes)) {
    const key = asString(entry?.key);
    if (!key) continue;
    out[key] = anyValueToJs(entry?.value);
  }
  return out;
}

function firstText(values) {
  for (const value of values) {
    const text = asString(value).trim();
    if (text) return text;
  }
  return undefined;
}

function normalizeLevel(severityText, severityNumber) {
  const levelText = asString(severityText).toLowerCase();
  if (levelText.includes('fatal') || levelText.includes('error')) return 'error';
  if (levelText.includes('warn')) return 'warn';
  if (levelText.includes('debug') || levelText.includes('trace')) return 'debug';

  const n = toNumber(severityNumber);
  if (n === undefined) return 'info';
  if (n >= 17) return 'error';
  if (n >= 13) return 'warn';
  if (n <= 4) return 'debug';
  return 'info';
}

function nanosToIso(value) {
  const raw = asString(value).trim();
  if (!raw) return undefined;
  try {
    const millis = Number(BigInt(raw) / 1000000n);
    if (!Number.isFinite(millis)) return undefined;
    return new Date(millis).toISOString();
  } catch {
    return undefined;
  }
}

function toMessage(bodyValue, attributes, severityText) {
  if (typeof bodyValue === 'string' && bodyValue.trim()) return bodyValue;
  if (typeof bodyValue === 'number' || typeof bodyValue === 'boolean') return String(bodyValue);
  if (bodyValue && typeof bodyValue === 'object') {
    try {
      return JSON.stringify(bodyValue);
    } catch {
      // Ignore and continue fallback chain.
    }
  }
  return firstText([
    attributes['event.name'],
    attributes['exception.message'],
    attributes['log.message'],
    severityText
  ]) || 'otel log record';
}

function spanKindLabel(kind) {
  const n = toNumber(kind);
  if (n === 1) return 'internal';
  if (n === 2) return 'server';
  if (n === 3) return 'client';
  if (n === 4) return 'producer';
  if (n === 5) return 'consumer';
  return 'unspecified';
}

function spanStatusCodeNumber(spanStatus) {
  const asNumber = toNumber(spanStatus?.code);
  return asNumber === undefined ? 0 : Math.trunc(asNumber);
}

function spanLevel(span, attributes) {
  const spanStatusCode = spanStatusCodeNumber(span?.status);
  if (spanStatusCode >= 2) return 'error';

  const httpStatus = toNumber(firstText([
    attributes['http.response.status_code'],
    attributes['http.status_code']
  ]));
  if (httpStatus !== undefined && httpStatus >= 500) return 'error';
  if (httpStatus !== undefined && httpStatus >= 400) return 'warn';
  return 'info';
}

function spanDurationMs(span) {
  const start = asString(span?.startTimeUnixNano).trim();
  const end = asString(span?.endTimeUnixNano).trim();
  if (!start || !end) return undefined;
  try {
    const startNs = BigInt(start);
    const endNs = BigInt(end);
    if (endNs < startNs) return undefined;
    const diffMs = Number((endNs - startNs) / 1000000n);
    return Number.isFinite(diffMs) ? diffMs : undefined;
  } catch {
    return undefined;
  }
}

function spanMessage(spanName, attributes, status) {
  const primary = asString(spanName).trim();
  if (primary) return primary;
  const route = firstText([attributes['http.route'], attributes['url.path'], attributes['rpc.method']]);
  if (route) return route;
  if (status && status.trim()) return status.trim();
  return 'otel span';
}

const edgeDataJsonParser = {
  id: 'edgedata_json',
  description: 'EdgeData JSON payload: array or { events: [...] }',
  canParse(context) {
    const payload = context.parsedBody;
    if (Array.isArray(payload)) return true;
    const body = asObject(payload);
    return !!(body && Array.isArray(body.events));
  },
  parse(context) {
    const payload = context.parsedBody;
    if (Array.isArray(payload)) {
      return { events: payload };
    }
    const body = asObject(payload);
    if (body && Array.isArray(body.events)) {
      return { events: body.events };
    }
    return { events: [] };
  }
};

const otlpJsonLogsParser = {
  id: 'otlp_http_json_logs',
  description: 'OpenTelemetry OTLP/HTTP JSON logs payload',
  canParse(context) {
    const payload = asObject(context.parsedBody);
    if (!payload) return false;
    if (Array.isArray(payload.resourceLogs)) return true;
    if (String(context.path || '').includes('/otlp')) return true;
    return false;
  },
  parse(context) {
    const payload = asObject(context.parsedBody);
    if (!payload) return { events: [] };

    const resourceLogs = asArray(payload.resourceLogs);
    const events = [];
    const defaults = {};

    for (const resourceLog of resourceLogs) {
      const resource = asObject(resourceLog?.resource);
      const resourceAttrs = attributesToObject(resource?.attributes);
      const scopeLogs = asArray(resourceLog?.scopeLogs?.length ? resourceLog.scopeLogs : resourceLog?.instrumentationLibraryLogs);

      const resourceService = firstText([resourceAttrs['service.name'], resourceAttrs['service.namespace']]);
      const resourceEnv = firstText([resourceAttrs['deployment.environment'], resourceAttrs['service.namespace']]);
      const resourceHost = firstText([resourceAttrs['host.name'], resourceAttrs['k8s.pod.name'], resourceAttrs['container.id']]);
      const resourceIndex = firstText([resourceAttrs['edgedata.index'], resourceAttrs['index']]);

      if (!defaults.service && resourceService) defaults.service = resourceService;
      if (!defaults.env && resourceEnv) defaults.env = resourceEnv;
      if (!defaults.host && resourceHost) defaults.host = resourceHost;
      if (!defaults.index && resourceIndex) defaults.index = resourceIndex;

      for (const scopeLog of scopeLogs) {
        const scope = asObject(scopeLog?.scope || scopeLog?.instrumentationLibrary);
        const scopeName = firstText([scope?.name]);
        const scopeVersion = firstText([scope?.version]);

        for (const record of asArray(scopeLog?.logRecords)) {
          const recordAttrs = attributesToObject(record?.attributes);
          const bodyValue = anyValueToJs(record?.body);
          const severityText = firstText([record?.severityText]);
          const mergedAttrs = {
            ...recordAttrs,
            otel_resource: resourceAttrs,
            otel_scope_name: scopeName,
            otel_scope_version: scopeVersion
          };

          const traceId = firstText([record?.traceId, recordAttrs['trace_id'], recordAttrs['trace.id']]);
          const requestId = firstText([record?.spanId, recordAttrs['request_id'], recordAttrs['http.request_id']]);
          const status = toNumber(firstText([recordAttrs['http.status_code'], recordAttrs['http.response.status_code'], recordAttrs.status]));
          const durationMs = toNumber(firstText([recordAttrs.duration_ms, recordAttrs['duration.ms'], recordAttrs['http.server.duration']]));
          const srcIp = firstText([recordAttrs['client.address'], recordAttrs['net.sock.peer.addr'], recordAttrs['source.ip']]);
          const userId = firstText([recordAttrs['enduser.id'], recordAttrs['user.id'], recordAttrs.user_id]);

          events.push({
            ts: nanosToIso(record?.timeUnixNano) || nanosToIso(record?.observedTimeUnixNano),
            index: firstText([recordAttrs['edgedata.index'], recordAttrs.index, resourceIndex]),
            service: firstText([recordAttrs['service.name'], resourceService]),
            env: firstText([recordAttrs['deployment.environment'], resourceEnv]),
            host: firstText([recordAttrs['host.name'], resourceHost]),
            level: normalizeLevel(severityText, record?.severityNumber),
            message: toMessage(bodyValue, recordAttrs, severityText),
            trace_id: traceId,
            request_id: requestId,
            status,
            duration_ms: durationMs,
            src_ip: srcIp,
            user_id: userId,
            attrs: mergedAttrs
          });
        }
      }
    }

    return { events, defaults };
  }
};

const otlpJsonTracesParser = {
  id: 'otlp_http_json_traces',
  description: 'OpenTelemetry OTLP/HTTP JSON traces payload',
  canParse(context) {
    const payload = asObject(context.parsedBody);
    if (!payload) return false;
    if (Array.isArray(payload.resourceSpans)) return true;
    if (String(context.path || '').includes('/traces')) return true;
    return false;
  },
  parse(context) {
    const payload = asObject(context.parsedBody);
    if (!payload) return { events: [] };

    const resourceSpans = asArray(payload.resourceSpans);
    const events = [];
    const defaults = {};

    for (const resourceSpan of resourceSpans) {
      const resource = asObject(resourceSpan?.resource);
      const resourceAttrs = attributesToObject(resource?.attributes);
      const scopeSpans = asArray(resourceSpan?.scopeSpans?.length ? resourceSpan.scopeSpans : resourceSpan?.instrumentationLibrarySpans);

      const resourceService = firstText([resourceAttrs['service.name'], resourceAttrs['service.namespace']]);
      const resourceEnv = firstText([resourceAttrs['deployment.environment'], resourceAttrs['service.namespace']]);
      const resourceHost = firstText([resourceAttrs['host.name'], resourceAttrs['k8s.pod.name'], resourceAttrs['container.id']]);
      const resourceIndex = firstText([resourceAttrs['edgedata.index'], resourceAttrs.index]);

      if (!defaults.service && resourceService) defaults.service = resourceService;
      if (!defaults.env && resourceEnv) defaults.env = resourceEnv;
      if (!defaults.host && resourceHost) defaults.host = resourceHost;
      if (!defaults.index && resourceIndex) defaults.index = resourceIndex;

      for (const scopeSpan of scopeSpans) {
        const scope = asObject(scopeSpan?.scope || scopeSpan?.instrumentationLibrary);
        const scopeName = firstText([scope?.name]);
        const scopeVersion = firstText([scope?.version]);

        for (const span of asArray(scopeSpan?.spans)) {
          const spanAttrs = attributesToObject(span?.attributes);
          const spanStatus = asObject(span?.status);

          const status = toNumber(firstText([
            spanAttrs['http.response.status_code'],
            spanAttrs['http.status_code'],
            spanStatus?.code
          ]));
          const durationMs = toNumber(firstText([
            spanAttrs.duration_ms,
            spanAttrs['duration.ms'],
            spanAttrs['http.server.duration']
          ])) ?? spanDurationMs(span);

          const mergedAttrs = {
            ...spanAttrs,
            otel_resource: resourceAttrs,
            otel_scope_name: scopeName,
            otel_scope_version: scopeVersion,
            otel_span_kind: spanKindLabel(span?.kind),
            otel_span_status_code: spanStatusCodeNumber(spanStatus),
            otel_span_status_message: firstText([spanStatus?.message]) || ''
          };

          const spanStatusMessage = firstText([spanStatus?.message]);
          events.push({
            ts: nanosToIso(span?.startTimeUnixNano) || nanosToIso(span?.endTimeUnixNano),
            index: firstText([spanAttrs['edgedata.index'], spanAttrs.index, resourceIndex]),
            service: firstText([spanAttrs['service.name'], resourceService]),
            env: firstText([spanAttrs['deployment.environment'], resourceEnv]),
            host: firstText([spanAttrs['host.name'], resourceHost]),
            level: spanLevel(span, spanAttrs),
            message: spanMessage(span?.name, spanAttrs, spanStatusMessage),
            trace_id: firstText([span?.traceId, spanAttrs['trace_id'], spanAttrs['trace.id']]),
            span_id: firstText([span?.spanId, spanAttrs['span_id'], spanAttrs['span.id']]),
            parent_span_id: firstText([span?.parentSpanId, spanAttrs['parent_span_id'], spanAttrs['parent.span_id']]),
            request_id: firstText([span?.spanId, spanAttrs['request_id'], spanAttrs['http.request_id']]),
            status,
            duration_ms: durationMs,
            src_ip: firstText([spanAttrs['client.address'], spanAttrs['net.sock.peer.addr'], spanAttrs['source.ip']]),
            user_id: firstText([spanAttrs['enduser.id'], spanAttrs['user.id'], spanAttrs.user_id]),
            attrs: mergedAttrs
          });
        }
      }
    }

    return { events, defaults };
  }
};

const ndjsonParser = {
  id: 'ndjson_lines',
  description: 'NDJSON payload with one JSON object per line',
  canParse(context) {
    if (isNdjsonContentType(context.contentType)) return true;
    if (!String(context.rawBody || '').includes('\n')) return false;
    const body = asString(context.rawBody).trim();
    if (!body) return false;
    const firstLine = body.split('\n').find((line) => line.trim());
    if (!firstLine) return false;
    return firstLine.trim().startsWith('{');
  },
  parse(context) {
    const events = [];
    for (const line of asString(context.rawBody).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (asObject(parsed)) events.push(parsed);
      } catch {
        // Ignore malformed lines so mixed payloads still ingest what is usable.
      }
    }
    return { events };
  }
};

const PARSERS = [otlpJsonLogsParser, otlpJsonTracesParser, edgeDataJsonParser, ndjsonParser];

export function listIngestParsers() {
  return PARSERS.map((parser) => ({
    id: parser.id,
    description: parser.description
  }));
}

export function parseIngestPayload(context) {
  const normalizedContext = {
    ...context,
    headers: normalizeHeaderMap(context?.headers),
    path: asString(context?.path),
    contentType: asString(context?.contentType),
    rawBody: asString(context?.rawBody)
  };

  const inferredBody = normalizedContext.parsedBody !== undefined
    ? normalizedContext.parsedBody
    : (isJsonContentType(normalizedContext.contentType)
      ? (() => {
          try {
            return JSON.parse(normalizedContext.rawBody);
          } catch {
            return undefined;
          }
        })()
      : undefined);
  normalizedContext.parsedBody = inferredBody;

  for (const parser of PARSERS) {
    try {
      if (!parser.canParse(normalizedContext)) continue;
      const parsed = parser.parse(normalizedContext);
      if (!parsed || !Array.isArray(parsed.events)) continue;
      return {
        parser: parser.id,
        events: parsed.events,
        defaults: asObject(parsed.defaults) || undefined
      };
    } catch {
      // Continue to the next parser instead of failing the whole request.
    }
  }

  return {
    parser: DEFAULT_PARSER,
    events: [],
    defaults: undefined
  };
}
