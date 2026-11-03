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

# Link the CLI onto PATH (~/.local/bin/tdo).
link:
    mkdir -p ~/.local/bin
    ln -sf "{{justfile_directory()}}/src/cli.ts" ~/.local/bin/tdo
    @echo "linked ~/.local/bin/tdo -> {{justfile_directory()}}/src/cli.ts"
