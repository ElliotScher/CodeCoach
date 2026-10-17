#!/usr/bin/env python3
#
# Minimal TimedRobot used as CodeCoach's RobotPy "hello" fixture.
#

import wpilib


class MyRobot(wpilib.TimedRobot):
    def robotInit(self) -> None:
        self.timer = wpilib.Timer()

    def autonomousInit(self) -> None:
        self.timer.restart()

    def autonomousPeriodic(self) -> None:
        pass

    def teleopPeriodic(self) -> None:
        pass
