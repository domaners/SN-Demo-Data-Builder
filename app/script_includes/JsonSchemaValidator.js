/**
 * Small JSON Schema validator covering the subset the blueprint schema uses:
 * type (single or list), const, enum, anyOf, properties, required,
 * additionalProperties: false, items, and format: hostname.
 *
 * Claude structured output already guarantees conformance for the Anthropic provider;
 * this check matters for hand-edited blueprints and providers without schema enforcement.
 *
 * @access package_private
 */
var JsonSchemaValidator = Class.create();

JsonSchemaValidator.HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

JsonSchemaValidator.typeOf = function (value) {
	if (value === null)
		return 'null';
	if (Array.isArray(value))
		return 'array';
	if (typeof value === 'number')
		return value % 1 === 0 ? 'integer' : 'number';
	return typeof value;
};

JsonSchemaValidator.prototype = {
	initialize: function (maxErrors) {
		this.maxErrors = maxErrors || 100;
	},

	/** @returns {Array<{path: string, message: string}>} */
	validate: function (value, schema) {
		const errors = [];
		this._check(value, schema, '$', errors);
		return errors;
	},

	_check: function (value, schema, path, errors) {
		if (errors.length >= this.maxErrors || !schema)
			return;

		if (schema.anyOf) {
			for (let i = 0; i < schema.anyOf.length; i++) {
				if (this.validate(value, schema.anyOf[i]).length === 0)
					return;
			}
			errors.push({ path: path, message: 'does not match any allowed form' });
			return;
		}

		if (schema.type) {
			const types = Array.isArray(schema.type) ? schema.type : [schema.type];
			const actual = JsonSchemaValidator.typeOf(value);
			const ok = types.indexOf(actual) >= 0 || (actual === 'integer' && types.indexOf('number') >= 0);
			if (!ok) {
				errors.push({ path: path, message: 'expected ' + types.join(' or ') + ', got ' + actual });
				return;
			}
		}

		if (schema.hasOwnProperty('const') && value !== schema['const'])
			errors.push({ path: path, message: 'must equal ' + JSON.stringify(schema['const']) });

		if (schema['enum'] && schema['enum'].indexOf(value) < 0)
			errors.push({ path: path, message: 'must be one of ' + schema['enum'].join(', ') + ' (got ' + JSON.stringify(value) + ')' });

		if (schema.format === 'hostname' && typeof value === 'string' && !JsonSchemaValidator.HOSTNAME.test(value))
			errors.push({ path: path, message: 'is not a valid hostname' });

		if (JsonSchemaValidator.typeOf(value) === 'object') {
			const props = schema.properties || {};
			const required = schema.required || [];
			for (let r = 0; r < required.length; r++) {
				if (!value.hasOwnProperty(required[r]))
					errors.push({ path: path, message: 'missing required property "' + required[r] + '"' });
			}
			const keys = Object.keys(value);
			for (let k = 0; k < keys.length; k++) {
				const key = keys[k];
				if (props.hasOwnProperty(key))
					this._check(value[key], props[key], path + '.' + key, errors);
				else if (schema.additionalProperties === false)
					errors.push({ path: path, message: 'unexpected property "' + key + '"' });
			}
		}

		if (Array.isArray(value) && schema.items) {
			for (let a = 0; a < value.length; a++)
				this._check(value[a], schema.items, path + '[' + a + ']', errors);
		}
	},

	type: 'JsonSchemaValidator'
};
