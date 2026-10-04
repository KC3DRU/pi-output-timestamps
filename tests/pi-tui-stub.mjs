/**
 * Minimal stand-in for @earendil-works/pi-tui, mapped in by registerHooks so the
 * extension can be unit-tested without installing pi-tui into this project.
 * Mirrors the real constructors' arity: Text(text, paddingX, paddingY), Container().
 */

export class Component {
	render(_width) {
		return [];
	}
}

export class Text extends Component {
	constructor(text = "", paddingX = 0, paddingY = 0) {
		super();
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	setText(text) {
		this.text = text;
	}

	render(_width) {
		return String(this.text).split("\n");
	}
}

export class Container extends Component {
	constructor() {
		super();
		this.children = [];
	}

	addChild(component) {
		this.children.push(component);
	}

	removeChild(component) {
		const i = this.children.indexOf(component);
		if (i >= 0) this.children.splice(i, 1);
	}

	clear() {
		this.children = [];
	}

	render(width) {
		return this.children.flatMap((child) => child.render(width));
	}
}
