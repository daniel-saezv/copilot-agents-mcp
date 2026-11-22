import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "fixtures/**", "dist/**"] },
  ...tseslint.configs.strict,
);
