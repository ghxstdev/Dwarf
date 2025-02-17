from PyQt5 import QtWidgets
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QStandardItemModel, QStandardItem
from PyQt5.QtWidgets import QMainWindow, QDockWidget
from dwarf.lib.types.module_info import ModuleInfo

from dwarf.lib import utils
from dwarf.ui.dialogs.dialog_input import InputDialog
from dwarf.ui.widgets.disasm_view import DisassemblyView
from dwarf.ui.widgets.hex_edit import HexEditor
from dwarf.ui.widgets.list_view import DwarfListView


DEBUG_VIEW_MEMORY = 0
DEBUG_VIEW_DISASSEMBLY = 1


class QDebugPanel(QMainWindow):
    def __init__(self, app, flags=None):
        super(QDebugPanel, self).__init__(flags)
        self.setDockOptions(QMainWindow.AnimatedDocks | QMainWindow.AllowNestedDocks | QMainWindow.AllowTabbedDocks)

        self.app = app
        self.q_settings = app.q_settings

        self.functions_list = DwarfListView()
        self.functions_list_model = QStandardItemModel(0, 1)
        self.functions_list_model.setHeaderData(0, Qt.Horizontal, '')
        self.functions_list.setModel(self.functions_list_model)
        self.functions_list.setHeaderHidden(True)
        self.functions_list.doubleClicked.connect(self._function_double_clicked)

        self.dock_functions_list = QDockWidget('Functions', self)
        self.dock_functions_list.setObjectName('functions')
        self.dock_functions_list.setWidget(self.functions_list)
        self.addDockWidget(Qt.LeftDockWidgetArea, self.dock_functions_list)
        self.resizeDocks([
            self.dock_functions_list
        ], [100], Qt.Horizontal)
        self.app.debug_view_menu.addAction(self.dock_functions_list.toggleViewAction())

        screen_size = QtWidgets.QDesktopWidget().screenGeometry(-1)
        m_width = screen_size.width()

        self.memory_panel = HexEditor(self.app)
        self.memory_panel.debug_panel = self
        self.memory_panel.dataChanged.connect(self.on_memory_modified)

        self.disassembly_panel = DisassemblyView(self.app)
        self.disassembly_panel.debug_panel = self

        self.dock_memory_panel = QDockWidget('Memory', self)
        self.dock_memory_panel.setWidget(self.memory_panel)
        self.dock_memory_panel.setObjectName('memory')

        self.dock_disassembly_panel = QDockWidget('Disassembly', self)
        self.dock_disassembly_panel.setWidget(self.disassembly_panel)
        self.dock_disassembly_panel.setObjectName('disassembly')

        self.addDockWidget(Qt.LeftDockWidgetArea, self.dock_memory_panel, Qt.Horizontal)
        self.addDockWidget(Qt.LeftDockWidgetArea, self.dock_disassembly_panel, Qt.Horizontal)
        if m_width >= 1920:
            self.splitDockWidget(self.dock_memory_panel, self.dock_disassembly_panel, Qt.Horizontal)
        else:
            self.tabifyDockWidget(self.dock_memory_panel, self.dock_disassembly_panel)

        self.restoreUiState()

    def restoreUiState(self):
        ui_state = self.q_settings.value('dwarf_debug_ui_state')
        if ui_state:
            self.restoreGeometry(ui_state)
        window_state = self.q_settings.value('dwarf_debug_ui_window')
        if window_state:
            self.restoreState(window_state)

    def closeEvent(self, event):
        self.q_settings.setValue('dwarf_debug_ui_state', self.saveGeometry())
        self.q_settings.setValue('dwarf_debug_ui_window', self.saveState())

    def showEvent(self, event):
        main_width = self.size().width()
        new_widths = [main_width * .1, main_width * .4, main_width * .5]
        self.resizeDocks([
            self.dock_functions_list, self.dock_memory_panel, self.dock_disassembly_panel
        ], new_widths, Qt.Horizontal)
        return super().showEvent(event)

    def update_functions(self, functions_list=None):
        if functions_list is None:
            functions_list = {}
        self.functions_list_model.setRowCount(0)
        for module_info_base in self.app.dwarf.database.modules_info:
            module_info = self.app.dwarf.database.modules_info[module_info_base]
            if len(module_info.functions) > 0:
                self.functions_list.show()
                for function in module_info.functions:
                    functions_list[function.name] = function.address

        for function_name in sorted(functions_list.keys()):
            function_addr = functions_list[function_name]
            item = QStandardItem(function_name.replace('.', '_'))
            item.setData(function_addr, Qt.UserRole + 2)
            self.functions_list_model.appendRow([item])

    def _function_double_clicked(self, model_index):
        item = self.functions_list_model.itemFromIndex(model_index)
        address = item.data(Qt.UserRole + 2)
        self.jump_to_address(address, view=DEBUG_VIEW_DISASSEMBLY)

    def on_context_setup(self):
        self.memory_panel.on_context_setup()

    def on_memory_modified(self, pos, length):
        data_pos = self.memory_panel.base + pos
        data = self.memory_panel.data[pos:pos + length]
        data = [data[0]]  # todo: strange js part

        if self.dwarf.dwarf_api('writeBytes', [data_pos, data]):
            pass
        else:
            utils.show_message_box('Failed to write Memory')

    def raise_memory_panel(self):
        self.dock_memory_panel.raise_()

    def raise_disassembly_panel(self):
        self.dock_disassembly_panel.raise_()

    def jump_to_address(self, address, view=DEBUG_VIEW_MEMORY):
        address = utils.parse_ptr(address)

        if view == DEBUG_VIEW_MEMORY:
            if self.memory_panel.number_of_lines() > 0:
                if self.is_address_in_view(view, address):
                    return
        elif view == DEBUG_VIEW_DISASSEMBLY:
            if self.disassembly_panel.number_of_lines() > 0:
                if self.is_address_in_view(view, address):
                    return

        self.app.dwarf.read_range_async(
            address, lambda base, data, offset: self._apply_data(base, data, offset, view=view))

    def _apply_data(self, base, data, offset, view=DEBUG_VIEW_MEMORY):
        # make sure we have that module in db before updating functions
        ModuleInfo.build_module_info(self.app.dwarf, base, fill_ied=True)

        self.update_functions()

        if view == DEBUG_VIEW_MEMORY:
            self.memory_panel.set_data(data, base=base, offset=offset)
            if not self.dock_memory_panel.isVisible():
                self.dock_memory_panel.show()
            self.raise_memory_panel()

            if self.disassembly_panel.number_of_lines() == 0:
                self.disassembly_panel.disasm(base, data, offset)
        elif view == DEBUG_VIEW_DISASSEMBLY:
            self.disassembly_panel.disasm(base, data, offset)
            if not self.dock_disassembly_panel.isVisible():
                self.dock_disassembly_panel.show()
            self.raise_disassembly_panel()

            if self.memory_panel.number_of_lines() == 0:
                self.memory_panel.set_data(data, base=base, offset=offset)

    def is_address_in_view(self, view, address):
        if view == DEBUG_VIEW_MEMORY:
            if self.memory_panel.data:
                ptr_exists = self.memory_panel.base <= address <= self.memory_panel.base + len(self.memory_panel.data)
                if ptr_exists:
                    self.memory_panel.caret.position = address - self.memory_panel.base
                    return True
        elif view == DEBUG_VIEW_DISASSEMBLY:
            if self.disassembly_panel.visible_lines() > 0:
                line_index_for_address = self.disassembly_panel.get_line_for_address(address)
                if line_index_for_address >= 0:
                    self.disassembly_panel.highlighted_line = line_index_for_address
                    self.disassembly_panel.verticalScrollBar().setValue(line_index_for_address)
                    return True
        return False

    def on_cm_jump_to_address(self, view=DEBUG_VIEW_MEMORY):
        ptr, _ = InputDialog.input_pointer(self.app)
        if ptr > 0:
            self.jump_to_address(ptr, view=view)

    def dump_data(self, address, _len):
        def _dump(ptr, data):
            if data is not None:
                from PyQt5.QtWidgets import QFileDialog
                _file = QFileDialog.getSaveFileName(self.app)
                with open(_file[0], 'wb') as f:
                    f.write(data)
        self.app.dwarf.read_memory_async(address, _len, _dump)
