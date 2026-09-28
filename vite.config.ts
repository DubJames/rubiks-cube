import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: '/rubiks-cube/',
})
// https://vite.dev/config/
// export default defineConfig({
//   plugins: [react()],
// })
