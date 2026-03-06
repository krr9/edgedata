const FUNCTIONS = {
  lower: (args) => String(args[0] ?? '').toLowerCase(),
  upper: (args) => String(args[0] ?? '').toUpperCase(),
  len: (args) => String(args[0] ?? '').length,
  substr: (args) => String(args[0] ?? '').substring(Number(args[1]) || 0, args[2] !== undefined ? Number(args[2]) : undefined),
  replace: (args) => String(args[0] ?? '').replaceAll(String(args[1] ?? ''), String(args[2] ?? '')),
  coalesce: (args) => args.find(a => a !== null && a !== undefined && a !== '') ?? null,
  if: (args) => args[0] ? args[1] : args[2],
};

export function evaluateExpression(expression, event) {
  const ifMatch = expression.match(/^if\s*\((.+)\)$/);
  if (ifMatch) {
    return evaluateIf(ifMatch[1], event);
  }

  const fnMatch = expression.match(/^(\w+)\s*\((.+)\)$/);
  if (fnMatch && FUNCTIONS[fnMatch[1].toLowerCase()]) {
    const fn = FUNCTIONS[fnMatch[1].toLowerCase()];
    const args = splitArgs(fnMatch[2]).map(a => resolveValue(a.trim(), event));
    return fn(args);
  }

  return evaluateArithmetic(expression, event);
}

function evaluateIf(argsStr, event) {
  const parts = splitArgs(argsStr);
  if (parts.length !== 3) return null;
  const condition = evaluateCondition(parts[0].trim(), event);
  return condition ? resolveValue(parts[1].trim(), event) : resolveValue(parts[2].trim(), event);
}

function evaluateCondition(cond, event) {
  const match = cond.match(/^([a-zA-Z_][a-zA-Z0-9_.]*|-?[0-9]+(?:\.[0-9]+)?|"[^"]*"|'[^']*')\s*(>=|<=|!=|>|<|=)\s*(.+)$/);
  if (!match) return !!resolveValue(cond, event);
  const left = resolveValue(match[1], event);
  const right = resolveValue(match[3], event);
  const op = match[2];
  const l = Number(left), r = Number(right);
  const numCompare = Number.isFinite(l) && Number.isFinite(r);
  if (op === '>=') return numCompare ? l >= r : String(left) >= String(right);
  if (op === '<=') return numCompare ? l <= r : String(left) <= String(right);
  if (op === '>') return numCompare ? l > r : String(left) > String(right);
  if (op === '<') return numCompare ? l < r : String(left) < String(right);
  if (op === '=') return numCompare ? l === r : String(left) === String(right);
  if (op === '!=') return numCompare ? l !== r : String(left) !== String(right);
  return false;
}

function evaluateArithmetic(expr, event) {
  const tokens = expr.match(/([a-zA-Z_][a-zA-Z0-9_.]*|[0-9]+(?:\.[0-9]+)?|[+\-*/()])/g);
  if (!tokens) return null;
  const resolved = tokens.map(t => {
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(t)) return t;
    if (/^[+\-*/()]$/.test(t)) return t;
    const val = event[t];
    return val !== undefined && val !== null ? String(val) : '0';
  }).join(' ');
  try {
    const result = Function('"use strict"; return (' + resolved + ')')();
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function resolveValue(token, event) {
  const trimmed = token.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) return Number(trimmed);
  return event[trimmed] ?? null;
}

function splitArgs(argsStr) {
  const args = [];
  let depth = 0, current = '', quote = null;
  for (const ch of argsStr) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { args.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current);
  return args;
}
