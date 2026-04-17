#!/bin/bash
#
# Bundle conduit-freerdp with its FreeRDP dylibs for distribution.
# Recursively discovers and bundles ALL non-system dylib dependencies.
# Resolves @rpath references using the local deps/install/lib/ directory.
# Creates freerdp-helper/bundle/darwin/ with the binary and all required libs.
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"
BUNDLE_DIR="$PROJECT_DIR/bundle/darwin"
DEPS_LIB="$PROJECT_DIR/deps/install/lib"
BINARY="$BUILD_DIR/conduit-freerdp"

# Ensure binary exists
if [ ! -f "$BINARY" ]; then
    echo "Error: Binary not found at $BINARY"
    echo "Run build-macos.sh first."
    exit 1
fi

echo "=== Bundling conduit-freerdp ==="

# Clean and create bundle dir
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

# Copy binary
cp "$BINARY" "$BUNDLE_DIR/"

# ── Recursively discover all non-system dylib dependencies ────────────

# Associative array: original_ref -> bundled_name
declare -A ALL_DYLIBS

is_system_lib() {
    local path="$1"
    case "$path" in
        /usr/lib/*|/System/*|@loader_path/*|@executable_path/*)
            return 0 ;;
        *)
            return 1 ;;
    esac
}

# Resolve a dylib path — handles @rpath by looking in deps/install/lib/
resolve_path() {
    local dep_path="$1"

    # @rpath reference: look in our deps lib directory
    if [[ "$dep_path" == @rpath/* ]]; then
        local basename="${dep_path#@rpath/}"
        local resolved="$DEPS_LIB/$basename"
        if [ -f "$resolved" ]; then
            echo "$resolved"
            return
        fi
    fi

    # Absolute path or other: try to resolve symlinks
    if [ -f "$dep_path" ]; then
        readlink -f "$dep_path" 2>/dev/null || realpath "$dep_path" 2>/dev/null || echo "$dep_path"
        return
    fi

    echo ""
}

# Recursively scan a file for non-system dylib dependencies
scan_deps() {
    local file="$1"
    while IFS= read -r line; do
        local dep_ref
        dep_ref=$(echo "$line" | awk '{print $1}')

        # Skip empty, system libs, and already-processed libs
        [ -z "$dep_ref" ] && continue
        is_system_lib "$dep_ref" && continue
        [ -n "${ALL_DYLIBS[$dep_ref]+x}" ] && continue

        local dep_name
        dep_name=$(basename "$dep_ref")

        local actual
        actual=$(resolve_path "$dep_ref")

        if [ -n "$actual" ] && [ -f "$actual" ]; then
            ALL_DYLIBS["$dep_ref"]="$dep_name"
            echo "  Found: $dep_ref -> $dep_name ($actual)"
            # Recurse into this dylib's dependencies
            scan_deps "$actual"
        else
            echo "  Warning: $dep_ref not found"
        fi
    done < <(otool -L "$file" | tail -n +2)
}

echo "Discovering all dependencies (recursive)..."
scan_deps "$BINARY"

echo ""
echo "Total non-system dylibs: ${#ALL_DYLIBS[@]}"

# ── Copy all dylibs ──────────────────────────────────────────────────

echo ""
echo "Copying dylibs..."
for dep_ref in "${!ALL_DYLIBS[@]}"; do
    name="${ALL_DYLIBS[$dep_ref]}"
    actual=$(resolve_path "$dep_ref")
    if [ -n "$actual" ] && [ -f "$actual" ]; then
        cp "$actual" "$BUNDLE_DIR/$name"
        chmod u+w "$BUNDLE_DIR/$name"
        echo "  Copied: $name"
    fi
done

# ── Bundle OpenSSL provider modules (legacy provider needed for NTLM/NLA) ──

echo ""
echo "Bundling OpenSSL provider modules..."
if [ -d "$DEPS_LIB/ossl-modules" ]; then
    mkdir -p "$BUNDLE_DIR/ossl-modules"
    cp "$DEPS_LIB/ossl-modules"/*.dylib "$BUNDLE_DIR/ossl-modules/" 2>/dev/null || true
    for f in "$BUNDLE_DIR/ossl-modules"/*.dylib; do
        [ -f "$f" ] || continue
        chmod u+w "$f"
        # Fix libcrypto reference: provider modules are in ossl-modules/ subdirectory,
        # so libcrypto.3.dylib is one level up at @loader_path/../
        while IFS= read -r line; do
            dep_path=$(echo "$line" | awk '{print $1}')
            dep_name=$(basename "$dep_path" 2>/dev/null)
            if [ "$dep_name" = "libcrypto.3.dylib" ] && [[ "$dep_path" != @loader_path/* ]]; then
                install_name_tool -change "$dep_path" "@loader_path/../libcrypto.3.dylib" "$f" 2>/dev/null || true
                echo "  Fixed: $(basename "$f"): $dep_path -> @loader_path/../libcrypto.3.dylib"
            fi
        done < <(otool -L "$f" | tail -n +2)
        echo "  Bundled: ossl-modules/$(basename "$f")"
    done
else
    echo "  WARNING: $DEPS_LIB/ossl-modules/ not found!"
    echo "  NTLM/NLA authentication will fail without the legacy provider."
    echo "  Rebuild OpenSSL with: bash build-freerdp.sh --clean && bash build-freerdp.sh"
fi

# ── Fix rpaths ───────────────────────────────────────────────────────

echo ""
echo "Fixing rpaths..."

# Build a set of all bundled basenames for quick lookup
declare -A BUNDLED_SET
for name in "${ALL_DYLIBS[@]}"; do
    BUNDLED_SET["$name"]=1
done

# Fix a single file: rewrite all references to bundled libs to @loader_path/
fix_references() {
    local file="$1"
    local file_name
    file_name=$(basename "$file")

    while IFS= read -r line; do
        local dep_path
        dep_path=$(echo "$line" | awk '{print $1}')
        [ -z "$dep_path" ] && continue

        local dep_name
        dep_name=$(basename "$dep_path")

        # If this dep is one of our bundled libs and not already @loader_path
        if [ -n "${BUNDLED_SET[$dep_name]+x}" ] && [[ "$dep_path" != @loader_path/* ]]; then
            install_name_tool -change "$dep_path" "@loader_path/$dep_name" "$file" 2>/dev/null || true
            echo "  $file_name: $dep_path -> @loader_path/$dep_name"
        fi
    done < <(otool -L "$file" | tail -n +2)
}

# Remove all non-portable rpaths from the binary, then add @loader_path
echo "Cleaning rpaths from binary..."
while IFS= read -r rp; do
    rp=$(echo "$rp" | xargs)
    [ -z "$rp" ] && continue
    case "$rp" in
        @loader_path*|@executable_path*) ;;
        *)
            install_name_tool -delete_rpath "$rp" "$BUNDLE_DIR/conduit-freerdp" 2>/dev/null || true
            echo "  Removed rpath: $rp"
            ;;
    esac
done < <(otool -l "$BUNDLE_DIR/conduit-freerdp" | grep -A2 LC_RPATH | grep "path " | sed 's/^[[:space:]]*path //' | sed 's/ (offset.*//')
install_name_tool -add_rpath @loader_path "$BUNDLE_DIR/conduit-freerdp" 2>/dev/null || true

# Fix the binary
echo "Fixing binary references..."
fix_references "$BUNDLE_DIR/conduit-freerdp"

# Fix each dylib
echo "Fixing dylib references..."
for name in "${ALL_DYLIBS[@]}"; do
    if [ -f "$BUNDLE_DIR/$name" ]; then
        # Set the install name to @loader_path/
        install_name_tool -id "@loader_path/$name" "$BUNDLE_DIR/$name" 2>/dev/null || true
        fix_references "$BUNDLE_DIR/$name"
    fi
done

# ── Ad-hoc sign everything (required for macOS Sequoia) ──────────────

echo ""
echo "Ad-hoc signing..."
for f in "$BUNDLE_DIR"/*; do
    codesign --force --sign - "$f" 2>/dev/null || true
    echo "  Signed: $(basename "$f")"
done
for f in "$BUNDLE_DIR"/ossl-modules/*.dylib; do
    [ -f "$f" ] || continue
    codesign --force --sign - "$f" 2>/dev/null || true
    echo "  Signed: ossl-modules/$(basename "$f")"
done

# ── Verify ───────────────────────────────────────────────────────────

echo ""
echo "=== Bundle complete ==="
echo "Bundle dir: $BUNDLE_DIR"
ls -lh "$BUNDLE_DIR"

echo ""
echo "Verifying binary references (should all be @loader_path/ or /usr/lib/ or /System/):"
otool -L "$BUNDLE_DIR/conduit-freerdp"

echo ""
echo "Checking for remaining non-system references..."
REMAINING=0
for f in "$BUNDLE_DIR"/*; do
    while IFS= read -r line; do
        dep_path=$(echo "$line" | awk '{print $1}')
        case "$dep_path" in
            /usr/lib/*|/System/*|@loader_path/*|@executable_path/*) ;;
            *)
                if [ -n "$dep_path" ]; then
                    echo "  WARNING: $(basename "$f") -> $dep_path"
                    REMAINING=$((REMAINING + 1))
                fi
                ;;
        esac
    done < <(otool -L "$f" | tail -n +2)
done

if [ "$REMAINING" -eq 0 ]; then
    echo "  All references resolved!"
else
    echo "  $REMAINING unresolved references (may cause runtime errors on machines without these libs)"
fi
