.PHONY: package

run-cc:
	(kill $(shell (lsof -ti:6969)) && sleep 3) || true
	OPENCHAMBER_BACKEND=claudecode bun run dev

run-oc:
	(kill $(shell (lsof -ti:6969)) && sleep 3) || true
	OPENCHAMBER_BACKEND=opencode bun run dev

# Detect platform and set appropriate bundle types
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
	BUNDLES := app
else ifeq ($(UNAME_S),Linux)
	BUNDLES := deb,rpm
else
	BUNDLES := msi,nsis
endif

package:
	bun install
	bun run --cwd packages/desktop build:sidecar
	bun run --cwd packages/desktop tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' --bundles $(BUNDLES)
