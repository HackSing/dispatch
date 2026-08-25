import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'out/',
      'dist/',
      'node_modules/',
      'coverage/',
      '.harness-tmp/',
      'dsh-plugin/vendor/',
      'dsh-plugin/lib/',
      // 验收证据归档(含探测脚本快照),是文档产物不是维护代码
      'docs/acceptance/evidence/'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    // 测试用 CommonJS mock 脚本(经 spawn 直跑,不走打包),豁免 ESM 规则并声明 Node 全局
    files: ['tests/fixtures/*.cjs'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        __dirname: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // 零依赖 node 启动器脚本(B5 批2,如 run-vitest.mjs):plain JS,声明用到的 Node 全局
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly'
      }
    }
  },
  {
    // dsh 插件与无头会话包:Node 环境纯 JS(host/脚本/测试),声明 Node 运行时全局
    files: ['dsh-plugin/**/*.{js,mjs}', 'dsh-headless-session/**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        fetch: 'readonly',
        queueMicrotask: 'readonly',
        setImmediate: 'readonly',
        structuredClone: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly'
      }
    }
  }
)
