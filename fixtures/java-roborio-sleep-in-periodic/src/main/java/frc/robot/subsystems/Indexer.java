// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot.subsystems;

import edu.wpi.first.wpilibj.DigitalInput;
import edu.wpi.first.wpilibj.smartdashboard.SmartDashboard;
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import frc.robot.Constants.ShooterConstants;

/** Tracks whether a game piece is loaded. */
public class Indexer extends SubsystemBase {
  private final DigitalInput m_beamBreak = new DigitalInput(ShooterConstants.kBeamBreakPort);
  private boolean m_hasPiece = false;

  public boolean hasPiece() {
    return m_hasPiece;
  }

  @Override
  public void periodic() {
    // Wait for the beam break to settle before reading it (it bounces).
    try {
      Thread.sleep(200);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
    m_hasPiece = !m_beamBreak.get();
    SmartDashboard.putBoolean("Has piece", m_hasPiece);
  }
}
