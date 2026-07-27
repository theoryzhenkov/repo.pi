{
  description = "Pi coding agent packages";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = lib.genAttrs systems;
      packageFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          runtimeSrc = pkgs.runCommand "pi-coding-agent-runtime-src" { } ''
            mkdir -p $out
            install -m 0644 ${self}/nix/runtime-package-lock.json $out/package-lock.json
            ${pkgs.nodejs_24}/bin/node -e '
              const fs = require("fs");
              const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
              fs.writeFileSync(process.argv[2], JSON.stringify(lock.packages[""], null, 2) + "\n");
            ' $out/package-lock.json $out/package.json
          '';
          runtimeNpmDeps = pkgs.fetchNpmDeps {
            src = runtimeSrc;
            name = "pi-coding-agent-runtime-npm-deps";
            hash = "sha256-VxKHolb+bsn3BP4V87GNnKpSFwpqFs1Apigxhha82ak=";
          };
        in
        pkgs.buildNpmPackage rec {
          pname = "pi-coding-agent";
          version = "0.82.0";

          src = self;
          nodejs = pkgs.nodejs_24;
          npmDepsHash = "sha256-FxykmZ+u9cd0WX7s4ZbH19aMGvIebZroR2IaNnltrGg=";
          makeCacheWritable = true;

          postPatch = ''
            cp ${self}/nix/package-lock.json package-lock.json
          '';

          npmInstallFlags = [ "--ignore-scripts" ];
          npmRebuildFlags = [ "--ignore-scripts" ];

          buildPhase = ''
            runHook preBuild

            npm --offline --workspace @earendil-works/pi-tui run build
            (cd packages/ai && npm --offline exec -- tsgo -p tsconfig.build.json)
            npm --offline --workspace @earendil-works/pi-agent-core run build
            npm --offline --workspace @earendil-works/pi-coding-agent run build

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            npm pack --offline --workspace @earendil-works/pi-coding-agent --pack-destination "$TMPDIR"
            tarball=$(echo "$TMPDIR"/*.tgz)
            mkdir -p "$TMPDIR/package"
            tar -xzf "$tarball" -C "$TMPDIR/package" --strip-components=1

            cp -R ${runtimeNpmDeps} "$TMPDIR/runtime-cache"
            chmod -R u+w "$TMPDIR/runtime-cache"

            pushd "$TMPDIR/package"
            cp ${runtimeSrc}/package.json package.json
            cp ${runtimeSrc}/package-lock.json package-lock.json
            chmod u+w package.json package-lock.json
            rm -f npm-shrinkwrap.json
            npm_config_cache="$TMPDIR/runtime-cache" npm install --offline --ignore-scripts --omit=dev --omit=optional
            popd

            mkdir -p "$out/lib/node_modules/@earendil-works" "$out/bin"
            cp -R "$TMPDIR/package" "$out/lib/node_modules/@earendil-works/pi-coding-agent"
            ln -s "$out/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$out/bin/pi"
            ln -s "$out/lib/node_modules/@earendil-works/pi-coding-agent/dist/bridge/cli.js" "$out/bin/pi-bridge"

            runHook postInstall
          '';

          meta = {
            description = "Pi coding agent CLI";
            homepage = "https://github.com/theoryzhenkov/repo.pi/tree/main/packages/coding-agent";
            license = lib.licenses.mit;
            mainProgram = "pi";
            platforms = nodejs.meta.platforms;
          };
        };
    in
    {
      packages = forAllSystems (system: rec {
        pi-coding-agent = packageFor system;
        default = pi-coding-agent;
      });
    };
}
