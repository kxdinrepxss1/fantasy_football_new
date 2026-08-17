/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark-first palette: this gets used on phones, often in the evening.
        ink: {
          900: '#0b1020',
          800: '#121a2e',
          700: '#1b2540',
          600: '#273353',
          500: '#3a4870',
        },
        accent: {
          DEFAULT: '#4ade80',
          dim: '#22c55e',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
