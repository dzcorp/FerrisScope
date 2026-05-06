.DEFAULT_GOAL := help
.PHONY: help install dev dev-safe dev-x11 check check-rust check-ts build build-release fmt clippy test test-frontend test-integration test-all icons clean nuke

# ---- env ----------------------------------------------------------------
NPM   ?= npm --prefix ui
CARGO ?= cargo
APP   := ferrisscope-app

# Invoke the Tauri CLI binary directly so its project search starts at the
# repo root. (`npm --prefix ui run tauri` would chdir to ui/ first and then
# fail to find crates/app/tauri.conf.json.)
TAURI := ui/node_modules/.bin/tauri

# ---- meta ---------------------------------------------------------------
help: ## Show this help
	@awk 'BEGIN{FS=":.*?## "} /^[a-zA-Z_-]+:.*?## /{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}' $(MAKEFILE_LIST)

# ---- setup --------------------------------------------------------------
install: ## Install frontend dependencies
	$(NPM) install

# ---- dev loop -----------------------------------------------------------
# The binary auto-detects the right Linux render path at startup
# (NVIDIA + Wayland → __NV_DISABLE_EXPLICIT_SYNC=1; everything else →
# vanilla GPU-accelerated WebKitGTK). See `configure_linux_render_env`
# in crates/app/src/main.rs for the decision tree, and the
# "linux render:" line in the startup log for what mode was picked.
dev: ## Run app in dev mode (vite + tauri; auto-detects Linux render path)
	$(TAURI) dev

# Conservative fallback: turns off WebKitGTK's DMA-BUF renderer and
# accelerated compositing entirely. Use this if `make dev` blank-screens
# or crashes on first paint — typically older NVIDIA proprietary or
# broken Mesa stacks.
dev-safe: ## Run app with conservative Linux defaults (DMABUF + compositing off)
	FERRISSCOPE_SAFE_MODE=1 $(TAURI) dev

# Force XWayland on a Wayland session while keeping full GPU
# acceleration. Use if native Wayland flickers or fails to repaint, but
# the safe-mode fallback is too slow.
dev-x11: ## Run app via XWayland with GPU acceleration (NVIDIA fallback)
	GDK_BACKEND=x11 $(TAURI) dev

# ---- type-check / lint / test -------------------------------------------
check: check-rust check-ts ## Type-check both backend and frontend

check-rust: ## cargo check the workspace
	$(CARGO) check --workspace --all-targets

check-ts: ## Type-check the frontend
	$(NPM) run build --silent --dry-run >/dev/null 2>&1 || true
	cd ui && npx tsc --noEmit

fmt: ## Format Rust + (no-op for TS until prettier is added)
	$(CARGO) fmt --all

clippy: ## Run clippy with workspace lints
	$(CARGO) clippy --workspace --all-targets -- -D warnings

test: ## Run backend tests
	$(CARGO) test --workspace

test-frontend: ## Run frontend tests (vitest)
	$(NPM) run test

test-integration: ## Run kind-cluster integration tests (requires Docker + kind)
	$(CARGO) test --workspace --features integration -- --test-threads=1

test-all: test test-frontend ## Run all unit tests (skips integration)

# ---- build --------------------------------------------------------------
build: ## Debug build of the binary (frontend not bundled)
	$(CARGO) build -p $(APP)

build-release: ## Release build (frontend built and bundled)
	$(NPM) run build
	$(CARGO) build -p $(APP) --release

bundle: ## Produce installable bundles (.deb / .AppImage / .dmg)
	$(NPM) run build
	$(TAURI) build

# ---- icons --------------------------------------------------------------
# Regenerate every raster icon from crates/app/icons/icon.svg. Run after
# editing the SVG. Requires ImageMagick 7+ (the `magick` binary).
ICON_DIR := crates/app/icons
ICON_SRC := $(ICON_DIR)/icon.svg

icons: ## Regenerate icon PNGs / ICO / per-size SVGs from icon.svg (requires `magick`)
	@command -v magick >/dev/null 2>&1 || { \
	  echo "error: ImageMagick 7+ ('magick' binary) not found on PATH"; \
	  exit 1; \
	}
	@test -f $(ICON_SRC) || { echo "error: $(ICON_SRC) missing"; exit 1; }
	# Rasters consumed by Tauri / Windows resource compiler.
	# `-depth 8` + `PNG32:` forces 8-bit RGBA. Tauri's bundler (specifically
	# the image crate's icns encoder) rejects 16-bit PNGs with
	# "unsupported ColorType: Rgba16" — ImageMagick otherwise promotes to
	# 16-bpc when the SVG has gradients.
	magick -background none $(ICON_SRC) -resize 512x512 -depth 8 PNG32:$(ICON_DIR)/icon.png
	magick -background none $(ICON_SRC) -resize 256x256 -depth 8 PNG32:$(ICON_DIR)/128x128@2x.png
	magick -background none $(ICON_SRC) -resize 128x128 -depth 8 PNG32:$(ICON_DIR)/128x128.png
	magick -background none $(ICON_SRC) -resize 32x32   -depth 8 PNG32:$(ICON_DIR)/32x32.png
	magick -background none $(ICON_SRC) -depth 8 \
	  \( -clone 0 -resize 16x16 \) \
	  \( -clone 0 -resize 24x24 \) \
	  \( -clone 0 -resize 32x32 \) \
	  \( -clone 0 -resize 48x48 \) \
	  \( -clone 0 -resize 64x64 \) \
	  \( -clone 0 -resize 128x128 \) \
	  \( -clone 0 -resize 256x256 \) \
	  -delete 0 $(ICON_DIR)/icon.ico
	# Per-size SVG snapshots (same content, width/height baked in for
	# fixed-dimension consumers — e.g. favicons, README badges, inline
	# embeds. The viewBox stays 0 0 512 512 so they remain crisp at any
	# scale; only the intrinsic width/height attributes differ.
	@for size in 16 32 64 128 256 512 1024; do \
	  out=$(ICON_DIR)/icon-$${size}.svg; \
	  sed -E 's/width="[0-9]+"/width="'$$size'"/; s/height="[0-9]+"/height="'$$size'"/' \
	    $(ICON_SRC) > $$out; \
	  echo "wrote $$out"; \
	done
	@echo "Regenerated rasters and per-size SVGs."
	@echo "macOS icon.icns is auto-derived by Tauri at bundle time."

# ---- cleanup ------------------------------------------------------------
clean: ## Remove build artifacts (keep node_modules)
	$(CARGO) clean
	rm -rf ui/dist crates/app/gen

nuke: clean ## Also remove node_modules and Cargo.lock
	rm -rf ui/node_modules
	@echo "Run 'make install' to restore."
