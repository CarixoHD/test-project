# Lessons

Short lessons from building this product, written by Slopper when work needed fixing. Read them before you start: they save you from mistakes earlier agents made.

- (#203) The test-honesty landmine covers every changed test file, so an old `vi.stubGlobal('fetch', vi.fn(...))` pattern fires as soon as you touch the file; rewrite network fakes with `msw/node` (`msw` is only an optional peer of vitest and must be added as a devDependency).
