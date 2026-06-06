#!/bin/sh
set -eu

dry_run=0

usage() {
  cat <<'EOF'
Install Tachikoma globally with npm.

Usage:
  sh install.sh [--dry-run]

By default this installs the prebuilt tarball from the latest GitHub release.

Environment:
  TACHIKOMA_PACKAGE   override install source: npm package name, git spec,
                      or tarball path/URL (default: latest GitHub release tgz)
  TACHIKOMA_VERSION   optional release tag to pin (e.g. v0.2.0). With the
                      default source it selects that release's tarball; with a
                      TACHIKOMA_PACKAGE override it is the npm version or git ref.
EOF
}

die() {
  printf 'tachikoma install: %s\n' "$1" >&2
  exit 1
}

npm_global_bin() {
  if npm bin -g >/dev/null 2>&1; then
    npm bin -g
    return
  fi

  prefix="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ "$prefix" != "undefined" ]; then
    printf '%s/bin\n' "$prefix"
  fi
}

verify_tachikoma() {
  bin="$1"
  "$bin" --version >/dev/null
  "$bin" --help >/dev/null
}

print_next_steps() {
  cat <<'EOF'

Next:
  tachikoma init
  tachikoma claude
  tachikoma codex
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $arg"
      ;;
  esac
done

command -v node >/dev/null 2>&1 || die "node is required"
command -v npm >/dev/null 2>&1 || die "npm is required"

release_url="https://github.com/yusugomori/tachikoma/releases"

if [ -n "${TACHIKOMA_PACKAGE:-}" ]; then
  # Explicit override: npm name, git spec, or tarball path/URL.
  package_name="$TACHIKOMA_PACKAGE"
  if [ -n "${TACHIKOMA_VERSION:-}" ]; then
    case "$package_name" in
      github:*|git+*|git@*|*.git)
        package_spec="${package_name}#${TACHIKOMA_VERSION}"
        ;;
      http://*|https://*|*.tgz|*.tar.gz|/*|./*)
        # tarball/URL already points at an exact artifact; version is ignored
        package_spec="$package_name"
        ;;
      *)
        package_spec="${package_name}@${TACHIKOMA_VERSION}"
        ;;
    esac
  else
    package_spec="$package_name"
  fi
elif [ -n "${TACHIKOMA_VERSION:-}" ]; then
  # Pin a specific GitHub release tag.
  package_spec="${release_url}/download/${TACHIKOMA_VERSION}/tachikoma.tgz"
else
  # Default: prebuilt tarball from the latest GitHub release.
  package_spec="${release_url}/latest/download/tachikoma.tgz"
fi

printf 'Installing Tachikoma: %s\n' "$package_spec"

if [ "$dry_run" -eq 1 ]; then
  printf 'dry-run: npm install -g %s\n' "$package_spec"
  print_next_steps
  exit 0
fi

npm install -g "$package_spec"

if command -v tachikoma >/dev/null 2>&1; then
  tachikoma_bin="$(command -v tachikoma)"
  verify_tachikoma "$tachikoma_bin" || die "installed tachikoma did not pass verification"
  printf 'Installed: %s\n' "$tachikoma_bin"
  print_next_steps
  exit 0
fi

global_bin="$(npm_global_bin)"
if [ -n "$global_bin" ] && [ -x "$global_bin/tachikoma" ]; then
  tachikoma_bin="$global_bin/tachikoma"
  verify_tachikoma "$tachikoma_bin" || die "installed tachikoma did not pass verification"
  cat <<EOF
Installed: $tachikoma_bin

Tachikoma was installed, but npm's global bin directory is not on PATH.
Add this to your shell profile:
  export PATH="$global_bin:\$PATH"
EOF
  print_next_steps
  exit 0
fi

die "tachikoma was installed but the binary was not found on PATH"
