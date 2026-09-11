# lmnr-cli dataset

Manage datasets in your Laminar project from the command line.

```bash
lmnr-cli dataset <command> [options]
```

Dataset commands authenticate as the signed-in user and target the project from
`--project-id` or the linked `.lmnr/project.json`. All commands support `--json`.

## Dataset CRUD

Datasets are addressed by UUID for get, update, and delete. Names do not need to
be unique.

```bash
lmnr-cli dataset list
lmnr-cli dataset get <dataset-id>
lmnr-cli dataset create <name>
lmnr-cli dataset update <dataset-id> --name <new-name>
lmnr-cli dataset delete <dataset-id>
```

`create` creates an empty dataset. `delete` is non-interactive and also deletes
the dataset's datapoints.

## Push and pull datapoints

Push and pull retain name-or-ID lookup for compatibility:

```bash
lmnr-cli dataset push <paths...> --id <dataset-id>
lmnr-cli dataset push <paths...> --name <name>
lmnr-cli dataset pull [output-path] --id <dataset-id>
lmnr-cli dataset pull [output-path] --name <name>
```

Push options include `--recursive` and `--batch-size`. Pull options include
`--output-format <json|csv|jsonl>`, `--batch-size`, `--limit`, and `--offset`.

## Import files into a new dataset

The former create-and-populate workflow is available as `import`:

```bash
lmnr-cli dataset import <name> <paths...> -o <output-file>
lmnr-cli dataset import examples data/ -r -o exported.jsonl
```

Import creates and populates a dataset, pulls the stored datapoints back, and
writes them to the required output file. Supported input/output formats are
JSON, JSONL, and CSV.
