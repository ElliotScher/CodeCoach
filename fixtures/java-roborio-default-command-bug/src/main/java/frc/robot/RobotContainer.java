// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot;

import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.button.CommandXboxController;
import frc.robot.Constants.OperatorConstants;
import frc.robot.subsystems.Drivetrain;

/** Subsystems, controller bindings and default commands. */
public class RobotContainer {
  private final Drivetrain m_drivetrain = new Drivetrain();

  private final CommandXboxController m_driverController =
      new CommandXboxController(OperatorConstants.kDriverControllerPort);

  public RobotContainer() {

    configureBindings();
  }

  private void configureBindings() {
    // Hold A to creep forward slowly (for lining up at the loading station).
    m_driverController.a().whileTrue(m_drivetrain.arcadeDriveCommand(() -> 0.3, () -> 0.0));
  }

  public Command getAutonomousCommand() {
    return Commands.none();
  }
}
