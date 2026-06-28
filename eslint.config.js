"use strict";

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    {
        ignores: [
            "node_modules/**",
            "coverage/**"
        ]
    },
    js.configs.recommended,
    {
        files: ["nodes/**/*.js", "test/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
                ...globals.mocha
            }
        },
        rules: {
            indent: ["error", 4, { SwitchCase: 1 }],
            quotes: ["error", "double", { avoidEscape: true }],
            semi: ["error", "always"],
            "no-empty": ["error", { allowEmptyCatch: true }],
            "no-unused-vars": ["error", {
                argsIgnorePattern: "^_",
                caughtErrorsIgnorePattern: "^_",
                varsIgnorePattern: "^should$"
            }]
        }
    }
];
