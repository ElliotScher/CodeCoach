// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot.subsystems;

import edu.wpi.first.math.controller.ArmFeedforward;
import edu.wpi.first.math.controller.PIDController;
import edu.wpi.first.wpilibj.Encoder;
import edu.wpi.first.wpilibj.motorcontrol.PWMSparkMax;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import frc.robot.Constants.ArmConstants;

/** A single-jointed arm with a quadrature encoder on the shaft. */
public class Arm extends SubsystemBase {
  private final PWMSparkMax m_motor = new PWMSparkMax(ArmConstants.kMotorPort);
  private final Encoder m_encoder = new Encoder(ArmConstants.kEncoderA, ArmConstants.kEncoderB);
  private final PIDController m_pid = new PIDController(ArmConstants.kP, 0, 0);
  private final ArmFeedforward m_feedforward =
      new ArmFeedforward(ArmConstants.kS, ArmConstants.kG, ArmConstants.kV);

  public Arm() {
    // 2048 counts per revolution, reported in degrees.
    m_encoder.setDistancePerPulse(360.0 / 2048.0);
  }

  /** Arm angle in degrees, 0 = horizontal. */
  public double getAngleDegrees() {
    return m_encoder.getDistance() + ArmConstants.kStartAngleDegrees;
  }

  /** Moves the arm to an angle (degrees) and holds it there. */
  public Command goToAngle(double targetDegrees) {
    return run(() -> {
          double angle = getAngleDegrees();
          double feedforward = m_feedforward.calculate(angle, 0);
          m_motor.setVoltage(m_pid.calculate(angle, targetDegrees) + feedforward);
        })
        .withName("goToAngle");
  }
}
