import {
  analyzeDoctorSourceTask,
  type DoctorSourceFileAnalysis,
  type DoctorSourceTask
} from './source-analysis.js'

export default function analyzeSourceInWorker(
  tasks: DoctorSourceTask[]
): DoctorSourceFileAnalysis[] {
  return tasks.map(analyzeDoctorSourceTask)
}
