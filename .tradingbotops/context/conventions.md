# Conventions

## Editing rules
- Small edits: use `sed`
- Multiline/structural Kotlin or JS changes: full rewrite via `cat > file << 'EOF'` (sed breaks on these)
- Complete, untruncated files only
- One file at a time — wait for confirmation before moving to the next
- No unsolicited additions — minimal solution to the stated task only
- Plans/architecture described before code, unless code was explicitly requested

## Git
- Commit messages: short, imperative (e.g. "fix lot sizing rounding bug")
- Push directly to `main` unless task file says otherwise
- Always include the resulting commit hash in the response file

## Communication format
- Task files and response files: plain markdown, no unnecessary preamble
- Reference task ID at the top of every response file
