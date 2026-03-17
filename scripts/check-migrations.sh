#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$ROOT/deploy/migrations}"
SCHEMA_FILE="${SCHEMA_FILE:-$ROOT/schema.sql}"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "FAIL: migrations directory not found: $MIGRATIONS_DIR"
  exit 1
fi

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "FAIL: schema file not found: $SCHEMA_FILE"
  exit 1
fi

MIGRATION_FILES="$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort)"

if [[ -z "$MIGRATION_FILES" ]]; then
  echo "FAIL: no migration files found in $MIGRATIONS_DIR"
  exit 1
fi

fail=0

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

extract_table_block() {
  local table_name="$1"
  awk -v target="$table_name" '
    BEGIN { in_table = 0 }
    $0 ~ "^CREATE TABLE IF NOT EXISTS " target " \\(" { in_table = 1 }
    in_table { print }
    in_table && $0 ~ /^\\);[[:space:]]*$/ { exit }
  ' "$SCHEMA_FILE"
}

check_schema_table() {
  local table_name="$1"
  if grep -qE "^CREATE TABLE IF NOT EXISTS ${table_name} " "$SCHEMA_FILE" 2>/dev/null; then
    echo "OK:   schema.sql -> table ${table_name} present"
  else
    echo "FAIL: schema.sql -> missing table ${table_name}"
    fail=1
  fi
}

check_schema_column() {
  local table_name="$1"
  local column_name="$2"
  local block
  block="$(extract_table_block "$table_name")"
  if [[ -z "$block" ]]; then
    echo "FAIL: schema.sql -> missing table ${table_name} for column ${column_name}"
    fail=1
    return
  fi

  if printf '%s\n' "$block" | grep -qE "^[[:space:]]*${column_name}[[:space:]]+" 2>/dev/null; then
    echo "OK:   schema.sql -> ${table_name}.${column_name} present"
  else
    echo "FAIL: schema.sql -> missing column ${table_name}.${column_name}"
    fail=1
  fi
}

check_schema_index() {
  local index_name="$1"
  if grep -qE "^CREATE INDEX IF NOT EXISTS ${index_name}([[:space:]]*$|[[:space:]]+ON)" "$SCHEMA_FILE" 2>/dev/null; then
    echo "OK:   schema.sql -> index ${index_name} present"
  else
    echo "FAIL: schema.sql -> missing index ${index_name}"
    fail=1
  fi
}

expected_next=""
last_number=""
seen_numbers=""

while IFS= read -r file; do
  base="$(basename "$file")"

  if [[ ! "$base" =~ ^([0-9]{3})_[A-Za-z0-9_]+\.sql$ ]]; then
    echo "FAIL: invalid migration filename format: $base"
    fail=1
    continue
  fi

  number="${BASH_REMATCH[1]}"
  numeric=$((10#$number))

  if printf '%s\n' "$seen_numbers" | grep -Fx "$number" >/dev/null 2>&1; then
    echo "FAIL: duplicate migration prefix detected: $number ($base)"
    fail=1
  fi
  seen_numbers="${seen_numbers}
${number}"

  if [[ -n "$last_number" ]]; then
    expected_next=$(printf "%03d" $((10#$last_number + 1)))
    if [[ "$number" != "$expected_next" ]]; then
      echo "FAIL: expected migration prefix ${expected_next} after ${last_number}, found ${number} ($base)"
      fail=1
    fi
  fi
  last_number="$number"

  first_nonempty="$(awk 'NF { print; exit }' "$file")"
  if [[ -z "$first_nonempty" ]]; then
    echo "FAIL: empty migration file: $base"
    fail=1
  elif [[ ! "$first_nonempty" =~ ^-- ]]; then
    echo "FAIL: migration file should start with a SQL comment header: $base"
    fail=1
  else
    echo "OK:   migration ${base}"
  fi

  while IFS= read -r line; do
    cleaned="$(trim "$line")"
    [[ -z "$cleaned" ]] && continue

    if [[ "$cleaned" =~ ^CREATE[[:space:]]+TABLE[[:space:]]+IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*\($ ]]; then
      check_schema_table "${BASH_REMATCH[1]}"
      continue
    fi

    if [[ "$cleaned" =~ ^ALTER[[:space:]]+TABLE[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+ADD[[:space:]]+COLUMN[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+ ]]; then
      check_schema_column "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
      continue
    fi

    if [[ "$cleaned" =~ ^CREATE[[:space:]]+INDEX[[:space:]]+IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*$ ]]; then
      check_schema_index "${BASH_REMATCH[1]}"
      continue
    fi

    if [[ "$cleaned" =~ ^CREATE[[:space:]]+INDEX[[:space:]]+IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+ON[[:space:]]+ ]]; then
      check_schema_index "${BASH_REMATCH[1]}"
      continue
    fi
  done < "$file"
done <<EOF
$MIGRATION_FILES
EOF

if [[ "$fail" -ne 0 ]]; then
  echo "Migration validation failed."
  exit 1
fi

echo "Migration validation passed."
