{
  description = "Rauthy development flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/47472570b1e607482890801aeaf29bfb749884f6";
    rust-overlay.url = "github:oxalica/rust-overlay";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    rust-overlay,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        overlays = [rust-overlay.overlays.default];
        pkgs = import nixpkgs {inherit system overlays;};
        rustToolchain = pkgs.rust-bin.nightly.latest.default.override {
          extensions = ["rust-src" "rustfmt" "clippy"];
          targets = ["wasm32-unknown-unknown"];
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rustToolchain
            clang
            mold
            nodejs_22
            just
            wasm-pack
            mdbook
            mdbook-admonish
          ];

          # Use mold for native Rust linking. Keep target-specific flags so
          # wasm-pack builds are unaffected.
          CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS = "-Clinker=clang -Clink-arg=-fuse-ld=mold";
          CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS = "-Clinker=clang -Clink-arg=-fuse-ld=mold";

          shellHook = ''
            # NixOS commonly exports target wrapper vars globally. Unset them
            # here so clang-based build scripts like jemalloc-sys detect the
            # host toolchain correctly.
            unset NIX_CC_WRAPPER_TARGET_HOST_x86_64_unknown_linux_gnu
            unset NIX_CC_WRAPPER_TARGET_BUILD_x86_64_unknown_linux_gnu
            echo "rauthy devshell: run 'just setup' once, then 'just pre-pr-checks' before submitting"
          '';
        };
      }
    );
}
