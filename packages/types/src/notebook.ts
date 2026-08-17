// Type definitions for Jupyter notebook functionality
// Used by NotebookReadTool and NotebookEditTool

/**
 * Valid notebook cell types
 */
export type NotebookCellType = 'code' | 'markdown'

/**
 * Notebook output image structure
 */
export interface NotebookOutputImage {
  image_data: string
  media_type: 'image/png' | 'image/jpeg'
}

/**
 * Processed notebook cell output for display
 */
export interface NotebookCellSourceOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error'
  text?: string
  image?: NotebookOutputImage
}

/**
 * Processed notebook cell structure used by tools
 */
export interface NotebookCellSource {
  cell: number // Cell index
  cellType: NotebookCellType
  source: string
  language: string
  execution_count?: number | null
  outputs?: NotebookCellSourceOutput[]
}

/**
 * Raw notebook cell output from .ipynb file
 */
export interface NotebookCellOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error'
  name?: string
  text?: string | string[]
  data?: Record<string, unknown>
  execution_count?: number | null
  metadata?: Record<string, unknown>
  // For error outputs
  ename?: string
  evalue?: string
  traceback?: string[]
}

/**
 * Raw notebook cell structure from .ipynb file
 */
export interface NotebookCell {
  cell_type: NotebookCellType
  source: string | string[]
  metadata: Record<string, unknown>
  execution_count?: number | null
  outputs?: NotebookCellOutput[]
  id?: string
}

/**
 * Complete notebook structure from .ipynb file
 */
export interface NotebookContent {
  cells: NotebookCell[]
  metadata: {
    kernelspec?: {
      display_name?: string
      language?: string
      name?: string
    }
    language_info?: {
      name?: string
      version?: string
      mimetype?: string
      file_extension?: string
    }
    [key: string]: unknown
  }
  nbformat: number
  nbformat_minor: number
}
