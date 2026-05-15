import { createHost } from './lib'
import { counterStore } from './stores/counter'

createHost([counterStore])
