-- Load this file from Rex's init.lua. Native prompts only work in a configured action.
rex.action({
  name = "tdo_work_prompt",
  title = "tdo: Pick Work Item (Internal)",
  args = { items_json = "string", project = "string" },
  run = function(_, args)
    if not rex.ui or not rex.ui.pick or not rex.ui.input then
      error("tdo work needs a Rex version with native prompts", 0)
    end

    local function ask(prompt, options)
      options.timeout = 60
      local value, why, detail = prompt(options)
      if value == nil and why ~= "cancelled" and why ~= "timeout" then
        error("tdo work: " .. (detail or why or "native prompt failed"), 0)
      end
      return value
    end

    local items, rows = rex.json.decode(args.items_json), {}
    for _, item in ipairs(items) do
      rows[#rows + 1] = { id = item.id, title = item.title, subtitle = item.subtitle }
    end
    local id = ask(rex.ui.pick, { title = "Work on a tdo · " .. args.project, placeholder = "Filter active items", items = rows })
    if id == nil then return { cancelled = true } end

    local selected
    for _, item in ipairs(items) do
      if item.id == id then selected = item; break end
    end
    if not selected then error("tdo work: unknown item selected", 0) end

    local name = ask(rex.ui.input, { title = "Worktree directory name", value = selected.suggestion, confirm = "Next" })
    if name == nil then return { cancelled = true } end
    local branch = ask(rex.ui.input, { title = "New Git branch", value = selected.suggestion, confirm = "Next" })
    if branch == nil then return { cancelled = true } end
    local launch = ask(rex.ui.pick, {
      title = "Create worktree " .. name .. " on branch " .. branch .. "?",
      confirm = "Create and open tab",
      items = {
        { id = "shell", title = "Open a shell", icon = "terminal" },
        { id = "pi", title = "Start Pi with this tdo as its prompt", icon = "code" },
      },
    })
    if launch == nil then return { cancelled = true } end
    return { id = id, name = name, branch = branch, launch = launch }
  end,
})
