#!/usr/bin/env bash
# Build "SCHEMA CHANGES (Lakebase diff)" from prod and CI schema SQL (unsorted pg_dump output).
# One object per block: + TABLE/INDEX (CREATED), ~ TABLE (MODIFIED) with added columns, - TABLE/INDEX (REMOVED).
# Usage: format-schema-diff.sh <prod-schema.sql> <ci-schema.sql>
set -e

PROD="${1:?}"
CI="${2:?}"
[ ! -f "$PROD" ] && echo "Missing prod schema: $PROD" >&2 && exit 1
[ ! -f "$CI" ] && echo "Missing CI schema: $CI" >&2 && exit 1

# Parse a schema file. Output "TABLE:name|col1|type1|col2|type2|" and "INDEX:name" (use | so types can contain colons).
parse_schema() {
  local file="$1"
  local in_table=""
  local name=""
  local cols=""
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == CREATE\ TABLE* ]]; then
      in_table=1
      name=$(echo "$line" | sed -n 's/.*CREATE TABLE[^.]*\.\([^ (]*\).*/\1/p')
      [ -z "$name" ] && name=$(echo "$line" | sed -n 's/.*CREATE TABLE[[:space:]]*\([^ (]*\).*/\1/p')
      cols=""
   elif [[ "$in_table" == 1 ]] && [[ "$line" =~ ^[[:space:]]*\)[[:space:]]*\;?[[:space:]]*$ ]]; then
      in_table=""
      [ -n "$name" ] && echo "TABLE:${name}|${cols}"
      name=""
    elif [[ "$in_table" == 1 ]] && [[ "$line" =~ ^[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]+ ]]; then
      rest=$(echo "$line" | sed 's/^[[:space:]]*//')
      [[ "$rest" == CONSTRAINT* ]] || [[ "$rest" == PRIMARY* ]] || [[ "$rest" == REFERENCES* ]] || [[ "$rest" == CHECK* ]] && continue
      cname=$(echo "$rest" | sed 's/[[:space:]].*//')
      ctype=$(echo "$rest" | sed 's/^[^[:space:]]*[[:space:]]*//;s/,[[:space:]]*$//' | sed 's/ NOT NULL.*//;s/ DEFAULT.*//;s/ PRIMARY KEY.*//')
      [[ "$ctype" == *REFERENCES* ]] && fk=$(echo "$ctype" | sed -n 's/.*REFERENCES[[:space:]]*[^.]*\.*\([^ ()]*\).*/\1/p') && [ -n "$fk" ] && ctype="${ctype%%REFERENCES*} (FK -> $fk)"
      cols="${cols:+$cols|}${cname}|${ctype}"
    elif [[ "$line" == CREATE\ INDEX* ]]; then
      idx=$(echo "$line" | sed -n 's/.*CREATE INDEX[[:space:]]*\([^[:space:]]*\).*/\1/p')
      [ -n "$idx" ] && echo "INDEX:$idx"
    fi
  done < "$file"
}

# Extract table names and index names from parse output (TABLE:name|... and INDEX:name)
table_names() { grep '^TABLE:' | cut -d: -f2 | cut -d'|' -f1 | sort -u; }
index_names() { grep '^INDEX:' | cut -d: -f2 | sort -u; }

PROD_TABLES=$(parse_schema "$PROD" | tee /tmp/prod_parsed.$$ | table_names)
CI_TABLES=$(parse_schema "$CI" | tee /tmp/ci_parsed.$$ | table_names)
PROD_INDEXES=$(parse_schema "$PROD" | index_names)
CI_INDEXES=$(parse_schema "$CI" | index_names)

# Output header
echo "**SCHEMA CHANGES (Lakebase diff)**"
echo ""

first=1
sep() { [ "$first" = 0 ] && echo ""; first=0; }
PROD_TABLES_SPACE=$(echo "$PROD_TABLES" | tr '\n' ' ')
CI_TABLES_SPACE=$(echo "$CI_TABLES" | tr '\n' ' ')
PROD_INDEXES_SPACE=$(echo "$PROD_INDEXES" | tr '\n' ' ')
CI_INDEXES_SPACE=$(echo "$CI_INDEXES" | tr '\n' ' ')

# New tables: in CI not in prod. Output + TABLE name (CREATED) and L col type.
for t in $CI_TABLES; do
  t=$(echo "$t" | tr -d '\n\r')
  echo " $PROD_TABLES_SPACE " | grep -q " $t " && continue
  sep
  echo "+ TABLE $t (CREATED)"
  line=$(grep "^TABLE:${t}|" /tmp/ci_parsed.$$ | head -1)
  if [ -n "$line" ]; then
    rest=$(echo "$line" | sed "s/^TABLE:${t}|//")
    echo "$rest" | tr '|' '\n' | paste - - 2>/dev/null | while IFS=$'\t' read -r col typ; do
      [ -n "$col" ] && [ -n "$typ" ] && echo "  L $col $typ"
    done
  fi
done

# New indexes
for i in $CI_INDEXES; do
  i=$(echo "$i" | tr -d '\n\r')
  echo " $PROD_INDEXES_SPACE " | grep -q " $i " && continue
  sep
  echo "+ INDEX $i (CREATED)"
done

# Modified tables: in both, different columns. Output ~ TABLE name (MODIFIED) and + col for added columns.
for t in $CI_TABLES; do
  t=$(echo "$t" | tr -d '\n\r')
  echo " $PROD_TABLES_SPACE " | grep -q " $t " || continue
  ci_line=$(grep "^TABLE:${t}|" /tmp/ci_parsed.$$ | head -1)
  prod_line=$(grep "^TABLE:${t}|" /tmp/prod_parsed.$$ | head -1)
  [ -z "$ci_line" ] || [ -z "$prod_line" ] && continue
  ci_rest=$(echo "$ci_line" | sed "s/^TABLE:${t}|//")
  prod_rest=$(echo "$prod_line" | sed "s/^TABLE:${t}|//")
  ci_cols=$(echo "$ci_rest" | tr '|' '\n' | awk 'NR%2==1')
  prod_cols=$(echo "$prod_rest" | tr '|' '\n' | awk 'NR%2==1')
  added=""
  prod_cols_space=$(echo "$prod_cols" | tr '\n' ' ')
  for c in $ci_cols; do
    c=$(echo "$c" | tr -d '\n\r')
    echo " $prod_cols_space " | grep -q " $c " || added="$added $c"
  done
  added=$(echo "$added" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -z "$added" ] && continue
  sep
  echo "~ TABLE $t (MODIFIED)"
  for col in $added; do
    col=$(echo "$col" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    typ=$(echo "$ci_rest" | awk -F'|' -v c="$col" '{for(i=1;i<NF;i+=2) if($i==c){print $(i+1); exit}}')
    [ -n "$typ" ] && echo "  + $col $typ"
  done
done

# Removed tables
for t in $PROD_TABLES; do
  t=$(echo "$t" | tr -d '\n\r')
  echo " $CI_TABLES_SPACE " | grep -q " $t " && continue
  sep
  echo "- TABLE $t (REMOVED)"
done

# Removed indexes
for i in $PROD_INDEXES; do
  i=$(echo "$i" | tr -d '\n\r')
  echo " $CI_INDEXES_SPACE " | grep -q " $i " && continue
  sep
  echo "- INDEX $i (REMOVED)"
done

rm -f /tmp/prod_parsed.$$ /tmp/ci_parsed.$$

if [ "$first" = 1 ]; then
  echo "No schema changes (in sync)."
fi
