#!/bin/bash
#
# lakebase-app-dev-kit – multi-target installer
#
# Modeled on databricks-solutions/ai-dev-kit/install.sh. One canonical
# skill tree (skills/lakebase-scm-workflows/), copied into the path each
# agent reads from.
#
# Usage:
#   bash <(curl -sL https://raw.githubusercontent.com/databricks-solutions/lakebase-app-dev-kit/main/install.sh) [OPTIONS]
#
# Examples:
#   # Auto-detect installed agents, prompt to pick
#   bash <(curl -sL .../install.sh)
#
#   # Install for specific targets
#   bash <(curl -sL .../install.sh) --tools claude,cursor
#
#   # Global install (~/.claude/skills, etc.) instead of project-scoped
#   bash <(curl -sL .../install.sh) --global
#
#   # After install, upload skills to a Databricks workspace for Genie Code
#   bash <(curl -sL .../install.sh) --install-to-genie [--profile DEFAULT]
#
# Targets supported in this release:
#   claude          – Claude Code (terminal). Path: .claude/skills/<name>/
#   cursor          – Cursor. Path: .cursor/skills/<name>/
#   genie           – Databricks Genie Code (workspace upload via `databricks workspace import-dir`)
#   claude-desktop  – Claude Desktop via the MCP server at apps/mcp-server/. Path: .mcp.json
#   openai-foundry  – OpenAI Foundry / Codex tool-spec JSON. Path: tools/openai-foundry/lakebase-app-dev-kit.tools.json

set -e

# Auto-discovered from the kit's skills/ tree at install time. Every
# directory under skills/ that contains a SKILL.md is treated as a
# skill and installed to each chosen agent's path. Today that covers
# the kit-authored workflow skills (lakebase-scm-workflows,
# lakebase-release-workflows, ...) AND the vendored upstream skills
# from devhub (databricks-core, databricks-lakebase) - consumers get
# both layers without thinking about it.
SKILL_NAMES=()  # populated after REPO_ROOT is resolved below
PRIMARY_SKILL="lakebase-scm-workflows"  # used for the "checking source" probe
OWNER="databricks-solutions"
REPO="lakebase-app-dev-kit"

# Defaults
TOOLS="${DEVKIT_TOOLS:-}"
SCOPE="${DEVKIT_SCOPE:-project}"
FORCE="${DEVKIT_FORCE:-false}"
DB_PROFILE="${DEVKIT_PROFILE:-DEFAULT}"
INSTALL_TO_GENIE=false

# Color helpers
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

usage() {
  cat <<EOF
lakebase-scm-workflows installer

Usage: install.sh [OPTIONS]

Options:
  --tools LIST            Comma-separated targets: claude,cursor,claude-desktop,openai-foundry
  --global                Install globally (~/.claude/skills, ~/.cursor/skills) instead of project-scoped
  --force                 Overwrite existing skill files without prompting
  --install-to-genie      After install, upload skills/ to Databricks workspace
  --profile NAME          Databricks CLI profile for --install-to-genie (default: DEFAULT)
  -h, --help              Show this help

Targets:
  claude           Claude Code (terminal)         Path: .claude/skills/<name>/                              (auto-detect)
  cursor           Cursor                         Path: .cursor/skills/<name>/                              (auto-detect)
  claude-desktop   Claude Desktop                 Wire .mcp.json into claude_desktop_config.json            (manual step printed)
  openai-foundry   OpenAI Foundry / Codex         tools/openai-foundry/lakebase-app-dev-kit.tools.json    (manual paste printed)
  genie            Databricks Genie Code          Workspace upload (use --install-to-genie)
EOF
}

# Parse args
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tools) TOOLS="$2"; shift 2 ;;
    --global) SCOPE="global"; shift ;;
    --force) FORCE=true; shift ;;
    --install-to-genie) INSTALL_TO_GENIE=true; shift ;;
    --profile) DB_PROFILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Source skill tree must be in $REPO_ROOT/skills/. When run via curl|bash
# we're outside the repo, so detect and clone first.
if [ -d "skills/$PRIMARY_SKILL" ]; then
  REPO_ROOT="$(pwd)"
else
  TMPDIR="$(mktemp -d)"
  echo -e "${BLUE}Cloning $REPO into $TMPDIR...${NC}"
  git clone --depth=1 "https://github.com/$OWNER/$REPO.git" "$TMPDIR/$REPO" > /dev/null 2>&1
  REPO_ROOT="$TMPDIR/$REPO"
fi

if [ ! -d "$REPO_ROOT/skills/$PRIMARY_SKILL" ]; then
  echo -e "${RED}Primary skill not found at $REPO_ROOT/skills/$PRIMARY_SKILL. Aborting.${NC}"
  exit 1
fi

# Build the substrate's dist/ via npm install. Skills declare CLI surfaces
# that consumers may invoke directly (e.g. `node dist/scripts/lakebase/
# get-connection.js`) - those need dist/ to exist. The kit's `prepare`
# script runs the build, so a plain `npm install` is sufficient.
# Idempotent: if dist/ already exists + matches package version, npm
# skips the rebuild.
if [ ! -d "$REPO_ROOT/dist" ] || [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo -e "${BLUE}Installing kit dependencies + building dist/ (this may take a minute)...${NC}"
  ( cd "$REPO_ROOT" && npm install --silent ) || {
    echo -e "${RED}npm install failed. Skills will still be copied but CLI surfaces won't work until you 'npm install' manually in $REPO_ROOT.${NC}"
  }
fi

# Discover every skill in the tree (any skills/<dir>/SKILL.md). Sorted
# alphabetically so install order is deterministic. Today this covers
# both kit-authored workflows (lakebase-scm-workflows, ...) and
# vendored upstream references (databricks-core, databricks-lakebase).
while IFS= read -r -d '' skill_md; do
  skill_dir="$(dirname "$skill_md")"
  skill_name="$(basename "$skill_dir")"
  SKILL_NAMES+=("$skill_name")
done < <(find "$REPO_ROOT/skills" -mindepth 2 -maxdepth 2 -name SKILL.md -print0 | sort -z)

if [ ${#SKILL_NAMES[@]} -eq 0 ]; then
  echo -e "${RED}No skills found under $REPO_ROOT/skills/. Aborting.${NC}"
  exit 1
fi

# Auto-detect installed agents when --tools not specified.
detect_tools() {
  local detected=""
  command -v claude >/dev/null 2>&1 && detected="${detected:+$detected,}claude"
  { [ -d "/Applications/Cursor.app" ] || command -v cursor >/dev/null 2>&1; } \
    && detected="${detected:+$detected,}cursor"
  echo "$detected"
}

if [ -z "$TOOLS" ]; then
  TOOLS="$(detect_tools)"
  if [ -z "$TOOLS" ]; then
    echo -e "${YELLOW}No supported agents detected. Pass --tools claude,cursor or install one of them first.${NC}"
    exit 1
  fi
  echo -e "${BLUE}Detected: $TOOLS${NC}"
fi

# Per-target + per-skill destination path (project vs global).
target_path() {
  local tool="$1" skill="$2"
  case "$tool" in
    claude)
      if [ "$SCOPE" = "global" ]; then echo "$HOME/.claude/skills/$skill"
      else echo ".claude/skills/$skill"; fi ;;
    cursor)
      if [ "$SCOPE" = "global" ]; then echo "$HOME/.cursor/skills/$skill"
      else echo ".cursor/skills/$skill"; fi ;;
    *) echo ""; return 1 ;;
  esac
}

# Install every discovered skill into the given tool's path.
install_one() {
  local tool="$1"

  # claude-desktop + openai-foundry don't fit the copy-tree pattern. Both
  # surface artifacts that the user wires into the agent manually
  # (Claude Desktop's claude_desktop_config.json, Foundry's tool config).
  if [ "$tool" = "claude-desktop" ]; then
    echo -e "${GREEN}  ✓ claude-desktop${NC} – copy the entry from ${BLUE}$REPO_ROOT/.mcp.json${NC} into your claude_desktop_config.json (under \"mcpServers\")."
    echo -e "    Substrate already built above; the @modelcontextprotocol/sdk optional peer dep is in place."
    return
  fi
  if [ "$tool" = "openai-foundry" ]; then
    local foundry_json="$REPO_ROOT/tools/openai-foundry/lakebase-app-dev-kit.tools.json"
    if [ ! -f "$foundry_json" ]; then
      echo -e "${YELLOW}  ! openai-foundry tool spec not built. Generating now...${NC}"
      ( cd "$REPO_ROOT" && python3 scripts/openai-foundry.py )
    fi
    echo -e "${GREEN}  ✓ openai-foundry${NC} – paste ${BLUE}$foundry_json${NC} into your Foundry / Codex tool config."
    return
  fi

  for skill in "${SKILL_NAMES[@]}"; do
    local skill_src="$REPO_ROOT/skills/$skill"
    local dest
    dest="$(target_path "$tool" "$skill")" || { echo -e "${YELLOW}    Skipping unknown target: $tool${NC}"; return; }

    if [ -d "$dest" ] && [ "$FORCE" != "true" ]; then
      read -p "    $dest exists. Overwrite? [y/N] " confirm
      [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && continue
    fi

    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    cp -R "$skill_src" "$dest"
    echo -e "${GREEN}    ✓ $skill → $dest${NC}"
  done
}

# Genie upload – uploads the skills/ tree to the user's Databricks workspace.
# Mirrors aikit's databricks-skills/install_skills.sh --install-to-genie.
install_to_genie() {
  if ! command -v databricks >/dev/null 2>&1; then
    echo -e "${RED}Error: databricks CLI not found. Install it for --install-to-genie.${NC}"
    return 1
  fi
  local current_user
  current_user="$(databricks current-user me -o json --profile "$DB_PROFILE" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['userName'])")"
  if [ -z "$current_user" ]; then
    echo -e "${RED}Could not resolve Databricks user. Check the --profile.${NC}"
    return 1
  fi
  for skill in "${SKILL_NAMES[@]}"; do
    local skill_src="$REPO_ROOT/skills/$skill"
    local workspace_path="/Users/$current_user/lakebase-app-dev-kit-skills/$skill"
    echo -e "${BLUE}Uploading $skill_src to $workspace_path (profile: $DB_PROFILE)${NC}"
    databricks workspace import-dir --overwrite "$skill_src" "$workspace_path" --profile "$DB_PROFILE"
    echo -e "${GREEN}  ✓ $skill → $workspace_path${NC}"
  done
}

# ── Main ──────────────────────────────────────────────────────────────
echo
echo -e "${BLUE}Installing ${#SKILL_NAMES[@]} skill(s) to: $TOOLS${NC}"
printf '  • %s\n' "${SKILL_NAMES[@]}"
echo
IFS=','
for tool in $TOOLS; do
  echo -e "${BLUE}→ $tool${NC}"
  install_one "$tool"
done
unset IFS

if [ "$INSTALL_TO_GENIE" = "true" ]; then
  echo
  install_to_genie
fi

echo
echo -e "${GREEN}Done.${NC}"
