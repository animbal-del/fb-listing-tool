/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"DM Sans"', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        ink: {
          50:  '#F0F2F5',
          100: '#E1E5EC',
          200: '#C3CAD9',
          300: '#9FABBE',
          400: '#6B7A99',
          500: '#3D4F72',
          600: '#2C3A5A',
          700: '#1E2B45',
          800: '#131D30',
          900: '#0A1120',
          950: '#060C18',
        },
        flame: {
          300: '#FF8F61',
          400: '#FF6B35',
          500: '#F04E11',
          600: '#D03D00',
        },
        jade: {
          400: '#34D399',
          500: '#10B981',
          600: '#059669',
        }
      }
    },
  },
  plugins: [],
}
