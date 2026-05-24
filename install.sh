#!/bin/bash
#
# lakebase-scm-workflows — multi-target installer
#
# Modeled on databricks-solutions/ai-dev-kit/install.sh. One canonical
# skill tree (skills/lakebase-scm-workflows/), copied into the path each
# agent reads from.
#
# Usage:
#   bash <(curl -sL https://raw.githubusercontent.com/databricks-solutions/lakebase-scm-workflows/main/install.sh) [OPTIONS]
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
#   claude      — Claude Code (terminal). Path: .claude/skills/<name>/
#   cursor      — Cursor. Path: .cursor/skills/<name>/
#   genie       — Databricks Genie Code (workspace upload via `databricks workspace import-dir`)
#
# Targets not yet wired (need MCP server impl):
#   claude-desktop — needs an MCP server (placeholder in .mcp.json; see apps/mcp-server)
#   openai-foundry — needs a custom GPT tool schema generator (no aikit precedent)

set -e

SKILL_NAME="lakebase-scm-workflows"
OWNER="databricks-solutions"
REPO="lakebase-scm-workflows"

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
  --tools LIST            Comma-separated targets: claude,cursor
  --global                Install globally (~/.claude/skills, ~/.cursor/skills) instead of project-scoped
  --force                 Overwrite existing skill files without prompting
  --install-to-genie      After install, upload skills/ to Databricks workspace
  --profile NAME          Databricks CLI profile for --install-to-genie (default: DEFAULT)
  -h, --help              Show this help

Targets (auto-detected):
  claude      Claude Code (terminal)         Path: .claude/skills/<name>/
  cursor      Cursor                          Path: .cursor/skills/<name>/
  genie       Databricks Genie Code           Workspace upload (use --install-to-genie)
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

# Source skill tree must be in $REPO_ROOT/skills/lakebase-scm-workflows/.
# When run via curl|bash we're outside the repo, so detect and clone first.
if [ -d "skills/$SKILL_NAME" ]; then
  REPO_ROOT="$(pwd)"
else
  TMPDIR="$(mktemp -d)"
  echo -e "${BLUE}Cloning $REPO into $TMPDIR...${NC}"
  git clone --depth=1 "https://github.com/$OWNER/$REPO.git" "$TMPDIR/$REPO" > /dev/null 2>&1
  REPO_ROOT="$TMPDIR/$REPO"
fi
SKILL_SRC="$REPO_ROOT/skills/$SKILL_NAME"

if [ ! -d "$SKILL_SRC" ]; then
  echo -e "${RED}Skill source not found at $SKILL_SRC. Aborting.${NC}"
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

# Per-target path (project vs global).
target_path() {
  case "$1" in
    claude)
      if [ "$SCOPE" = "global" ]; then echo "$HOME/.claude/skills/$SKILL_NAME"
      else echo ".claude/skills/$SKILL_NAME"; fi ;;
    cursor)
      if [ "$SCOPE" = "global" ]; then echo "$HOME/.cursor/skills/$SKILL_NAME"
      else echo ".cursor/skills/$SKILL_NAME"; fi ;;
    *) echo ""; return 1 ;;
  esac
}

# Install per target.
install_one() {
  local tool="$1"
  local dest
  dest="$(target_path "$tool")" || { echo -e "${YELLOW}Skipping unknown target: $tool${NC}"; return; }

  if [ -d "$dest" ] && [ "$FORCE" != "true" ]; then
    read -p "  $dest exists. Overwrite? [y/N] " confirm
    [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && return
  fi

  mkdir -p "$(dirname "$dest")"
  rm -rf "$dest"
  cp -R "$SKILL_SRC" "$dest"
  echo -e "${GREEN}  ✓ $tool → $dest${NC}"
}

# Genie upload — uploads the skills/ tree to the user's Databricks workspace.
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
  local workspace_path="/Users/$current_user/lakebase-scm-skills/$SKILL_NAME"
  echo -e "${BLUE}Uploading $SKILL_SRC to workspace path $workspace_path (profile: $DB_PROFILE)${NC}"
  databricks workspace import-dir --overwrite "$SKILL_SRC" "$workspace_path" --profile "$DB_PROFILE"
  echo -e "${GREEN}  ✓ Genie Code skill uploaded to $workspace_path${NC}"
}

# ── Main ──────────────────────────────────────────────────────────────
echo
echo -e "${BLUE}Installing $SKILL_NAME to: $TOOLS${NC}"
echo
IFS=','
for tool in $TOOLS; do
  install_one "$tool"
done
unset IFS

if [ "$INSTALL_TO_GENIE" = "true" ]; then
  echo
  install_to_genie
fi

echo
echo -e "${GREEN}Done.${NC}"
