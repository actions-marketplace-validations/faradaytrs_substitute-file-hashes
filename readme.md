# Substitute File Hashes

GitHub Action to replace `${{ hashFile('filepath') }}` and `${{ hashFile('filepath', N) }}` with actual file hashes in files matching a glob pattern.
Paths that start with `./` or `../` are resolved relative to the file currently being processed. Other paths are resolved from the workspace root.

**Use cases**

You have a configuration file or a Kubernetes manifest where you need to embed the hash of another file (like a ConfigMap or Secret data file) to trigger rollouts when the file changes.

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      annotations:
        config-hash: ${{ hashFile('./config/settings.json', 12) }}
```

After running this action, it will be transformed to:

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      annotations:
        config-hash: 8d969eef6eca
```

**Workflow YAML**

```yaml
- name: Substitute File Hashes
  uses: faradaytrs/substitute-file-hashes@v1.0.0
  with:
    # Glob pattern for files to process
    files: '**/*.yaml'

    # (Optional) Hashing algorithm from Node.js crypto API. Default is sha256.
    algorithm: sha256

    # (Optional) Fail if hashFile points to a missing file. Default is true.
    throwIfFileNotExists: true
```

## hashFile path resolution

Path resolution rules for `hashFile(...)`:

- Paths starting with `./` or `../` are resolved relative to the file currently being processed.
- All other paths are resolved from the workspace root.

Examples:

- In `services/api/deployment.yaml`, `hashFile('./config/app.json')` resolves to `services/api/config/app.json`.
- In `services/api/deployment.yaml`, `hashFile('../shared/config.json')` resolves to `services/shared/config.json`.
- `hashFile('configs/global.json')` resolves from workspace root.

## hashFile length argument

You can use an optional second argument to limit the output hash length:

- `hashFile('path/to/file')` -> full hash.
- `hashFile('path/to/file', N)` -> first `N` characters of the hash.

Rules for `N`:

- `N` is optional.
- `N` must be an integer `>= 1`.
- `N` must not exceed the produced hash length for the chosen algorithm.

If `N` is invalid, the action fails with an error that includes the file and expression.

Use short hashes carefully: smaller `N` increases the risk of collisions.

When `throwIfFileNotExists` is:
- `true` (default): action fails if any referenced file does not exist after path resolution.
- `false`: action logs a warning and leaves the original `hashFile(...)` expression unchanged when the resolved file is missing or outside workspace.
