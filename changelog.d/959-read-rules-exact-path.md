### Guardrail changes: what each one does

- **Every path a lane's sandbox denies is denied to the Read tool by its exact path too (#959):** a lane's sandbox
  settings wrote each `denyRead` entry as a directory rule only (`Read(//x/**)`), which may not match a single file
  such as a credential or config file. Each denied path now becomes both `Read(//x/**)` and `Read(//x)`, through the
  one function that writes these rules; a test refuses any other place that builds one.
