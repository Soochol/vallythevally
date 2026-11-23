use std::io;
use std::process::{Child, Command};

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::process::CommandExt;

    pub struct ParentBond {
        parent: libc::pid_t,
    }

    impl ParentBond {
        pub fn new() -> io::Result<Self> {
            Ok(ParentBond { parent: unsafe { libc::getpid() } })
        }

        pub fn prepare(&self, command: &mut Command) {
            let parent = self.parent;
            unsafe {
                command.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::getppid() != parent {
                        return Err(io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    Ok(())
                });
            }
        }

        pub fn attach(&self, _child: &Child) -> io::Result<()> {
            Ok(())
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    pub struct ParentBond {
        job: HANDLE,
    }

    unsafe impl Send for ParentBond {}
    unsafe impl Sync for ParentBond {}

    impl ParentBond {
        pub fn new() -> io::Result<Self> {
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            let set = unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size) };
            if set == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(ParentBond { job })
        }

        pub fn prepare(&self, command: &mut Command) {
            command.creation_flags(CREATE_NO_WINDOW);
        }

        pub fn attach(&self, child: &Child) -> io::Result<()> {
            if unsafe { AssignProcessToJobObject(self.job, child.as_raw_handle() as HANDLE) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }
}

pub use platform::ParentBond;
