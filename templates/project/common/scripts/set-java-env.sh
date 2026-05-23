#!/usr/bin/env bash
# Set JAVA_HOME and PATH for JDK 25. Source this or run: source scripts/set-java-env.sh
# Use after installing JDK 25 (see docs/install-jdk25.md).

set_java_25() {
  local candidates=(
    "/opt/homebrew/opt/openjdk"
    "/usr/local/opt/openjdk"
    "/opt/homebrew/opt/openjdk@25"
    "/usr/local/opt/openjdk@25"
    "$HOME/.sdkman/candidates/java/25.0.2-tem"
    "$HOME/.sdkman/candidates/java/25.0.1-tem"
    "/Library/Java/JavaVirtualMachines/temurin-25.jdk/Contents/Home"
    "/Library/Java/JavaVirtualMachines/openjdk-25.jdk/Contents/Home"
    "/Library/Java/JavaVirtualMachines/openjdk.jdk/Contents/Home"
  )
  for dir in "${candidates[@]}"; do
    if [[ -d "$dir" && -x "$dir/bin/java" ]]; then
      export JAVA_HOME="$dir"
      export PATH="$JAVA_HOME/bin:$PATH"
      echo "Using JAVA_HOME=$JAVA_HOME"
      return 0
    fi
  done
  # Fallback: use java_home if available (macOS)
  if command -v /usr/libexec/java_home &>/dev/null; then
    local home
    home=$(/usr/libexec/java_home -v 25 2>/dev/null) && {
      export JAVA_HOME="$home"
      export PATH="$JAVA_HOME/bin:$PATH"
      echo "Using JAVA_HOME=$JAVA_HOME (from java_home)"
      return 0
    }
  fi
  echo "JDK 25 not found. Install it (see docs/install-jdk25.md) and re-run this script." >&2
  return 1
}
set_java_25
