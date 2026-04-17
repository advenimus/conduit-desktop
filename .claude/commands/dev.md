# Conduit Development Workflow

You are continuing development on Conduit, an AI-powered remote connection manager. Follow this workflow precisely.

## Step 1: Read Documentation

Read these files to understand current state:

1. `docs/PROGRESS.md` - Check milestone status and task completion
2. `docs/TECHNICAL_SPEC.md` - Understand architecture (if needed)
3. Identify the current phase from PROGRESS.md (first phase with incomplete tasks)
4. Read the corresponding phase doc: `docs/phases/PHASE_XX_*.md`

## Step 2: Assess Current State

Before writing any code:

1. **Check what exists**: Use Glob/Grep to see what files/code already exist
2. **Identify the next incomplete task** from the current phase
3. **Understand dependencies**: What must exist before this task can be done?

## Step 3: Implement

For each task:

1. **Implement the code** following the phase documentation
2. **Follow existing patterns** - check similar existing code first
3. **Keep changes focused** - one task at a time

## Step 4: Verify (CRITICAL)

After implementing each task, you MUST verify it works:

### For Rust Code:
```bash
# Check it compiles
cargo check --workspace

# Run tests for the specific crate
cargo test -p <crate-name>

# If no tests exist yet, at minimum verify compilation
cargo build --workspace
```

### For Frontend Code:
```bash
# Check TypeScript compiles
npm run build

# Run tests if they exist
npm test
```

### For Tauri Integration:
```bash
# Verify the app launches
cargo tauri dev
```

### Troubleshooting:
- If compilation fails, fix errors before proceeding
- If tests fail, fix them before marking complete
- If runtime errors occur, debug and resolve
- Document any blockers in PROGRESS.md

## Step 5: Update Progress (Only After Verification)

Only after a task is verified working:

1. Update `docs/PROGRESS.md`:
   - Change task status from 🔴 to 🟢
   - Add any notes about the implementation
   - If blocked, mark as 🔵 and document the blocker

2. If the entire phase is complete:
   - Update the milestone status in the Quick Status table
   - Add a note in the "Notes & Updates" section

## Task Status Legend

- 🔴 Not Started
- 🟡 In Progress
- 🟢 Complete
- 🔵 Blocked

## Example Workflow

```
1. Read PROGRESS.md → Phase 1 is current, task "Initialize Rust workspace" is 🔴
2. Read PHASE_01_SCAFFOLDING.md for implementation details
3. Check if Cargo.toml exists (it doesn't)
4. Create Cargo.toml following the phase doc
5. Run `cargo check --workspace` → Success
6. Update PROGRESS.md: task is now 🟢
7. Move to next task
```

## Important Rules

1. **Never skip verification** - Always test before marking complete
2. **One task at a time** - Complete and verify each task before starting the next
3. **Document blockers** - If something can't be completed, document why
4. **Follow the phase docs** - They contain the implementation details
5. **Don't update progress prematurely** - Only after verification passes

Now begin by reading docs/PROGRESS.md to determine current state.
