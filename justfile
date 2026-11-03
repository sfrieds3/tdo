# List available commands.
default:
    @just --list

# Install dev dependencies.
install:
    pnpm install

# Run the test suite.
test:
    pnpm test

# Type-check the sources.
typecheck:
    pnpm typecheck

# Run all validation.
check: typecheck test

# Link the CLI onto PATH and the skill into ~/.agents/skills and ~/.claude/skills.
link:
    mkdir -p ~/.local/bin ~/.agents/skills ~/.claude/skills
    ln -sfn "{{justfile_directory()}}/src/cli.ts" ~/.local/bin/tdo
    ln -sfn "{{justfile_directory()}}/skills/tdo" ~/.agents/skills/tdo
    ln -sfn "{{justfile_directory()}}/skills/tdo" ~/.claude/skills/tdo
    @echo "linked ~/.local/bin/tdo, ~/.agents/skills/tdo, ~/.claude/skills/tdo"
