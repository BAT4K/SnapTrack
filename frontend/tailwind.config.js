/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                surface: '#141414',
                surfaceBorder: '#2a2a2a',
                accent: '#FF5F1F',
                accentHover: '#ff7a45'
            },
            fontFamily: {
                mono: ['JetBrains Mono', 'monospace'],
                display: ['Bebas Neue', 'sans-serif'],
            }
        },
    },
    plugins: [],
}