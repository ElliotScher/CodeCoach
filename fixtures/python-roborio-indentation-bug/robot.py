#!/usr/bin/env python3
#
# Arcade drive robot.
#

import wpilib
import wpilib.drive


class MyRobot(wpilib.TimedRobot):
    def robotInit(self) -> None:
        self.left = wpilib.PWMSparkMax(0)
        self.right = wpilib.PWMSparkMax(1)
        # The right gearbox is mirrored, so it spins the other way.
        self.right.setInverted(True)
        self.drive = wpilib.drive.DifferentialDrive(self.left, self.right)
        self.controller = wpilib.XboxController(0)

    def autonomousPeriodic(self) -> None:
        self.drive.stopMotor()


def teleopPeriodic(self) -> None:
    self.drive.arcadeDrive(-self.controller.getLeftY(), -self.controller.getRightX())
