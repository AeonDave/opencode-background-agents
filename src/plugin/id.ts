import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"

function generateReadableId(): string {
	return uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: "-",
		length: 3,
		style: "lowerCase",
	})
}

export { generateReadableId }
