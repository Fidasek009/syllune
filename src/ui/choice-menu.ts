export type Choice<Value extends string = string> = {
	value: Value
	label: string
}

type ChoiceMenuConfig<Value extends string> = {
	button: HTMLButtonElement
	menu: HTMLElement
	onChange(value: Value): void
}

export type ChoiceMenu<Value extends string> = {
	readonly value: Value | undefined
	setChoices(choices: readonly Choice<Value>[], value?: Value): void
	close(): void
}

/**
 * Popover listbox. The browser supplies light dismiss and top-layer stacking;
 * the menu holds focus and reports the keyboard position with
 * aria-activedescendant. Callers position the menu.
 */
export function choiceMenu<Value extends string>({
	button,
	menu,
	onChange,
}: ChoiceMenuConfig<Value>): ChoiceMenu<Value> {
	const label = button.querySelector<HTMLElement>(".choice-label")
	if (!label || !menu.id) throw new Error("Choice menu needs a .choice-label child and a menu id")
	const name = button.dataset.label
	let choices: readonly Choice<Value>[] = []
	let options: HTMLElement[] = []
	let selected: Value | undefined
	let active = 0
	let typing = ""
	let typingUntil = 0

	const paint = (value: Value | undefined) => {
		selected = value
		const choice = choices.find((entry) => entry.value === value)
		const text = choice?.label ?? ""
		label.textContent = text
		button.dataset.value = value ?? ""
		button.title = text
		button.setAttribute("aria-label", name ? `${name}: ${text}` : text)
		for (const [index, option] of options.entries())
			option.setAttribute("aria-selected", String(choices[index]?.value === value))
	}

	function activate(index: number) {
		if (!choices.length) return
		active = Math.max(0, Math.min(choices.length - 1, index))
		const option = options[active]
		if (!option) return
		menu.setAttribute("aria-activedescendant", option.id)
		for (const [index, entry] of options.entries()) entry.classList.toggle("active", index === active)
		option.scrollIntoView({ block: "nearest" })
	}

	function close() {
		if (menu.matches(":popover-open")) menu.hidePopover()
	}

	function commit(value: Value) {
		paint(value)
		close()
		button.focus()
		onChange(value)
	}

	function typeahead(key: string) {
		const now = performance.now()
		typing = now > typingUntil ? key : typing + key
		typingUntil = now + 600
		const query = typing.toLowerCase()
		const chars = [...query]
		const first = chars[0] ?? query
		// Repeating one letter steps through the matches, as a native select does.
		const repeated = chars.length > 1 && chars.every((char) => char === first)
		const needle = repeated ? first : query
		const from = repeated ? active + 1 : 0
		for (let offset = 0; offset < choices.length; offset++) {
			const index = (from + offset) % choices.length
			const choice = choices[index]
			if (choice?.label.toLowerCase().startsWith(needle)) {
				activate(index)
				return
			}
		}
	}

	function choose(index: number) {
		const choice = choices[index]
		if (choice) commit(choice.value)
	}

	button.setAttribute("aria-haspopup", "listbox")
	button.setAttribute("aria-expanded", "false")
	button.setAttribute("aria-controls", menu.id)
	// The invoker relationship keeps light dismiss from swallowing the click that
	// should close the menu, so a second press on the trigger toggles it.
	button.popoverTargetElement = menu
	menu.addEventListener("focusout", (event) => {
		const next = event.relatedTarget
		if (next instanceof Node && (menu.contains(next) || next === button)) return
		close()
	})
	menu.addEventListener("toggle", (event) => {
		const opened = (event as ToggleEvent).newState === "open"
		button.setAttribute("aria-expanded", String(opened))
		if (opened) {
			const index = choices.findIndex((choice) => choice.value === selected)
			activate(index < 0 ? 0 : index)
			menu.focus()
		} else if (menu.contains(document.activeElement)) button.focus()
	})
	menu.addEventListener("click", (event) => {
		const option = (event.target as Element | null)?.closest<HTMLElement>("[role=option]")
		if (option) choose(options.indexOf(option))
	})
	menu.addEventListener("keydown", (event) => {
		const actions: Record<string, () => void> = {
			ArrowDown: () => activate(active + 1),
			ArrowUp: () => activate(active - 1),
			Home: () => activate(0),
			End: () => activate(choices.length - 1),
			Enter: () => choose(active),
			" ": () => choose(active),
			Escape: () => {
				close()
				button.focus()
			},
		}
		const action = actions[event.key]
		if (action) {
			event.preventDefault()
			event.stopPropagation()
			action()
		} else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault()
			typeahead(event.key)
		}
	})

	return {
		get value() {
			return selected
		},
		setChoices(next, value = selected) {
			choices = next
			options = next.map((choice, index) => {
				const option = document.createElement("div")
				option.id = `${menu.id}-option-${index}`
				option.setAttribute("role", "option")
				option.className = "choice-option"
				option.textContent = choice.label
				option.title = choice.label
				return option
			})
			menu.replaceChildren(...options)
			paint(next.some((choice) => choice.value === value) ? value : next[0]?.value)
		},
		close,
	}
}
