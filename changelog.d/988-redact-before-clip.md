### Guardrail changes: what each one does

- **Run records and the run feed redact before they clip (#988).** Each text either store cuts short (a command, its output, the final message, a failed run's detail, a plugin or MCP server name, the stuck guard's repeated input, and every feed item's text, input, diff and output) is redacted whole first, then cut. A secret across the cut was cut short of its rule and stored as the part that was kept; now it is hidden whole. The stored text is still redacted again as a whole, as before.
