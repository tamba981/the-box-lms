export class ApiResponse {
  static success<T>(data: T, message: string = 'Success') {
    return {
      success: true,
      message,
      data,
      timestamp: new Date().toISOString()
    }
  }

  static error(message: string, statusCode: number = 400) {
    return {
      success: false,
      message,
      statusCode,
      timestamp: new Date().toISOString()
    }
  }
}
