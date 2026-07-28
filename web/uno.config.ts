import { defineConfig, presetUno } from 'unocss';

// 不启用 preflight（reset），避免干扰 Naive UI 基线
export default defineConfig({
  presets: [presetUno()],
});