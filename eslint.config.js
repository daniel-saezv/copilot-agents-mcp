import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".agents/**", "node_modules/**", "fixtures/**", "dist/**"] },
  ...tseslint.configs.strict,
);
