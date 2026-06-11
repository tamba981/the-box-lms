import QRCode from 'qrcode'
import crypto from 'crypto'
import { Certificate } from '../models/Certificate.model'
import { Enrollment } from '../models/Enrollment.model'
import { User } from '../models/User.model'
import { Course } from '../models/Course.model'

export class CertificateService {
  static async generateCertificateNumber(): Promise<string> {
    const prefix = 'TBOX'
    const timestamp = Date.now().toString(36)
    const random = crypto.randomBytes(4).toString('hex').toUpperCase()
    return `${prefix}-${timestamp}-${random}`
  }

  static async generateCertificate(
    studentId: string,
    courseId: string,
    enrollmentId: string,
    type: string
  ) {
    try {
      const [student, course, enrollment] = await Promise.all([
        User.findById(studentId),
        Course.findById(courseId),
        Enrollment.findById(enrollmentId),
      ])

      if (!student || !course || !enrollment) {
        throw new Error('Required data not found')
      }

      const certificateNumber = await this.generateCertificateNumber()
      
      // Generate QR code with verification URL
      const verificationUrl = `${process.env.FRONTEND_URL}/verify-certificate/${certificateNumber}`
      const qrCode = await QRCode.toDataURL(verificationUrl)

      // Generate blockchain hash (simplified)
      const blockchainHash = crypto
        .createHash('sha256')
        .update(`${certificateNumber}-${studentId}-${courseId}-${Date.now()}`)
        .digest('hex')

      // Generate PDF URL (simplified - in production, use PDF generation library)
      const pdfUrl = `${process.env.FRONTEND_URL}/certificates/${certificateNumber}.pdf`

      const certificate = await Certificate.create({
        certificateNumber,
        student: studentId,
        course: courseId,
        enrollment: enrollmentId,
        type,
        studentName: `${student.firstName} ${student.lastName}`,
        courseTitle: course.title,
        issueDate: new Date(),
        qrCode,
        blockchainHash,
        pdfUrl,
        isVerified: true,
      })

      // Update enrollment
      enrollment.certificateIssued = true
      enrollment.certificateId = certificate._id.toString()
      await enrollment.save()

      return certificate
    } catch (error) {
      console.error('Certificate generation error:', error)
      throw new Error('Failed to generate certificate')
    }
  }

  static async verifyCertificate(certificateNumber: string) {
    try {
      const certificate = await Certificate.findOne({ certificateNumber })
        .populate('student', 'firstName lastName')
        .populate('course', 'title')

      if (!certificate) {
        return { isValid: false, message: 'Certificate not found' }
      }

      // Increment verification count
      certificate.verificationCount += 1
      await certificate.save()

      return {
        isValid: true,
        certificate: {
          number: certificate.certificateNumber,
          studentName: certificate.studentName,
          courseTitle: certificate.courseTitle,
          type: certificate.type,
          issueDate: certificate.issueDate,
          blockchainHash: certificate.blockchainHash,
        },
      }
    } catch (error) {
      console.error('Verification error:', error)
      return { isValid: false, message: 'Verification failed' }
    }
  }

  static async getUserCertificates(userId: string) {
    return Certificate.find({ student: userId })
      .populate('course', 'title thumbnail')
      .sort({ issueDate: -1 })
  }

  static async downloadCertificate(certificateId: string) {
    const certificate = await Certificate.findById(certificateId)
    if (!certificate) {
      throw new Error('Certificate not found')
    }

    // In production, generate PDF on demand
    return certificate.pdfUrl
  }
}