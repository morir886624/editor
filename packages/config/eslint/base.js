import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Shared base rule sets for every workspace. Consumers spread these into
 * their own `extends` and add framework-specific plugins on top.
 */
export const baseExtends = [js.configs.recommended, tseslint.configs.recommended]
