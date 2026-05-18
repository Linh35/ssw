import { createHost } from '../src'
import { counterStore } from './counter'

createHost([counterStore])
