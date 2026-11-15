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
	const labelElement = button.querySelector<HTMLElement>(".choice-label")
	if (!labelElement || !menu.id) throw new Error("Choice menu needs a .choice-label child and a menu id")
	const label = labelElement
	const name = button.dataset.label
	let choices: readonly Choice<Value>[] = []
	let selected: Value | undefined
	let active = 0
	let typing = ""
	let typingUntil = 0

	const options = () => Array.from(menu.querySelectorAll<HTMLElement>("[role=option]"))

	function paint(value: Value | undefined) {
		selected = value
		const choice = choices.find((entry) => entry.value === value)
		const text = choice?.label ?? ""
		label.textContent = text
		button.dataset.value = value ?? ""
		button.title = text
		button.setAttribute("aria-label", name ? `${name}: ${text}` : text)
		for (const [index, option] of options().entries())
			option.setAttribute("aria-selected", String(choices[index]?.value === value))
	}

	function activate(index: number) {
		if (!choices.length) return
		active = Math.max(0, Math.min(choices.length - 1, index))
		const option = options()[active]
		if (!option) return
		menu.setAttribute("aria-activedescendant", option.id)
		for (const [index, entry] of options().entries()) entry.classList.toggle("active", index === active)
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

	function open() {
		if (!choices.length) return
		const index = choices.findIndex((choice) => choice.value === selected)
		menu.showPopover()
		activate(index < 0 ? 0 : index)
		menu.focus()
	}

	function typeahead(key: string) {
		const now = performance.now()
		typing = now > typingUntil ? key : typing + key
		typingUntil = now + 600
		const query = typing.toLowerCase()
		const index = choices.findIndex((choice) => choice.label.toLowerCase().startsWith(query))
		if (index >= 0) activate(index)
	}

	function choose(index: number) {
		const choice = choices[index]
		if (choice) commit(choice.value)
	}

	button.setAttribute("aria-haspopup", "listbox")
	button.setAttribute("aria-expanded", "false")
	button.setAttribute("aria-controls", menu.id)
	button.addEventListener("click", () => (menu.matches(":popover-open") ? close() : open()))
	menu.addEventListener("focusout", (event) => {
		const next = event.relatedTarget
		if (next instanceof Node && (menu.contains(next) || next === button)) return
		close()
	})
	menu.addEventListener("toggle", (event) => {
		const opened = (event as ToggleEvent).newState === "open"
		button.setAttribute("aria-expanded", String(opened))
		if (!opened && menu.contains(document.activeElement)) button.focus()
	})
	menu.addEventListener("click", (event) => {
		const option = (event.target as Element | null)?.closest<HTMLElement>("[role=option]")
		if (option) choose(options().indexOf(option))
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
			menu.replaceChildren(
				...next.map((choice, index) => {
					const option = document.createElement("div")
					option.id = `${menu.id}-option-${index}`
					option.setAttribute("role", "option")
					option.className = "choice-option"
					option.textContent = choice.label
					return option
				}),
			)
			paint(next.some((choice) => choice.value === value) ? value : next[0]?.value)
		},
		close,
	}
}
